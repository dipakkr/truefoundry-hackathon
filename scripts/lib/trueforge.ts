// Thin REST client for the TrueForge settings/agents API (bodies follow the OpenAPI at /api/v1/docs).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, TRUEFORGE_BASE_URL, TRUEFORGE_START_CMD, env, errMsg } from './common.js';

export interface TfResponse<T = any> {
  status: number; // 0 = network error
  ok: boolean;
  body: T;
  error?: string; // server `error.message` or network error
}

export async function tf<T = any>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<TfResponse<T>> {
  const url = `${TRUEFORGE_BASE_URL}/api/v1${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    const error = res.ok ? undefined : (parsed?.error?.message ?? (typeof parsed === 'string' ? parsed : `HTTP ${res.status}`));
    return { status: res.status, ok: res.ok, body: parsed as T, error };
  } catch (e) {
    return { status: 0, ok: false, body: null as T, error: errMsg(e) };
  }
}

export async function trueforgeReachable(): Promise<{ ok: boolean; detail: string }> {
  const r = await tf('GET', '/capabilities', undefined, 5_000);
  if (r.ok) return { ok: true, detail: TRUEFORGE_BASE_URL };
  return { ok: false, detail: `${TRUEFORGE_BASE_URL} unreachable (${r.error})` };
}

/** Human hint for errors the real API is known to return. */
export function hintFor(error: string | undefined): string | undefined {
  if (!error) return undefined;
  if (/Outbound URL blocked for host "(localhost|127\.0\.0\.1)"/.test(error)) {
    return `TrueForge blocks localhost by default. Restart it with: ${TRUEFORGE_START_CMD}`;
  }
  if (/Outbound URL blocked/.test(error)) return 'TrueForge refused that host (SSRF guard). Use a public hostname or add it to OUTBOUND_URL_ALLOWED_HOSTS.';
  if (/provider not configured|Unknown model/.test(error)) return 'No model provider: set TFY_GATEWAY_BASE_URL + TFY_GATEWAY_API_KEY + MODEL_ID (or OPENAI_API_KEY) in .env, then re-run `npm run setup`.';
  if (/Unknown MCP server "github"/.test(error)) return 'GitHub MCP not registered: set GITHUB_TOKEN (fine-grained PAT) or run `gh auth login`, then re-run `npm run setup`.';
  if (/Unknown MCP server "pgwarden"/.test(error)) return 'pgwarden MCP not registered: set PGWARDEN_TOKEN in .env and re-run `npm run setup`.';
  if (/Unknown skill/.test(error)) return 'Skill not registered: set SKILL_REPO_URL (public GitHub repo) + SKILL_REF and re-run `npm run setup`.';
  if (/Daytona rejected/.test(error)) return 'Daytona rejected DAYTONA_API_KEY. Create a key with Sandboxes + Snapshots write at app.daytona.io.';
  return undefined;
}

// ---------- model ----------
/** Resource names must match ^[a-z][a-z0-9-]{0,62}[a-z0-9]$ (so no "/" or "." from gateway ids). */
export function resourceSlug(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(s)) s = `m-${s}`;
  s = s.slice(0, 64).replace(/-+$/, '');
  return s.length >= 2 ? s : `${s}x`;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';
/** Catalog providers (type + key env var + default model) that setup can configure without a gateway. */
export const CATALOG_PROVIDERS = {
  openai: { key: 'OPENAI_API_KEY', model: DEFAULT_OPENAI_MODEL },
  anthropic: { key: 'ANTHROPIC_API_KEY', model: DEFAULT_ANTHROPIC_MODEL },
} as const;

export type ModelMode = 'tfy-gateway' | 'openai' | 'anthropic' | 'none';

export function modelMode(): ModelMode {
  if (env('TFY_GATEWAY_BASE_URL') && env('TFY_GATEWAY_API_KEY') && env('MODEL_ID')) return 'tfy-gateway';
  if (env('OPENAI_API_KEY')) return 'openai';
  if (env('ANTHROPIC_API_KEY')) return 'anthropic';
  return 'none';
}

/**
 * The model FQN the agents use. CONTRACTS §2 says `tfy-gateway/${MODEL_ID}`; TrueForge requires the
 * model's *name* to be a resource slug, so the FQN uses the slug and the raw MODEL_ID goes in model_id.
 * MODEL_FQN in .env overrides everything.
 */
export function modelFqn(openaiCatalogModels?: Array<{ name: string; model_id: string }>): string | undefined {
  if (env('MODEL_FQN')) return env('MODEL_FQN');
  const mode = modelMode();
  if (mode === 'tfy-gateway') return `tfy-gateway/${resourceSlug(env('MODEL_ID')!)}`;
  if (mode === 'openai' || mode === 'anthropic') {
    const wanted = env('MODEL_ID') ?? CATALOG_PROVIDERS[mode].model;
    const hit = openaiCatalogModels?.find((m) => m.model_id === wanted || m.name === wanted);
    return `${mode}/${hit ? hit.name : resourceSlug(wanted)}`;
  }
  return undefined;
}

// ---------- agents ----------
export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  manifest: any;
}

export async function listAgents(): Promise<TfResponse<AgentRecord[]>> {
  const all: AgentRecord[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await tf<{ data: AgentRecord[]; pagination?: { next_page_token?: string } }>(
      'GET',
      `/agents?limit=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`,
    );
    if (!r.ok) return { ...r, body: all };
    all.push(...(r.body.data ?? []));
    token = r.body.pagination?.next_page_token;
    if (!token) break;
  }
  return { status: 200, ok: true, body: all };
}

export interface AgentFile {
  name: string;
  description: string;
  manifest: any;
  unresolved: string[];
}

/**
 * Load `agent/<file>`: `${VAR}` placeholders are substituted in the raw text before JSON.parse
 * (vars first, then process.env). Accepts either {name, description, manifest} or a bare AgentSpec.
 */
export function loadAgentFile(relPath: string, fallbackName: string, vars: Record<string, string | undefined>):
  | { ok: true; agent: AgentFile }
  | { ok: false; error: string } {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return { ok: false, error: `${relPath} not found (WS3 has not written it yet)` };
  const unresolved: string[] = [];
  const raw = readFileSync(abs, 'utf8').replace(/\$\{([A-Z0-9_]+)\}/g, (m, name: string) => {
    const v = vars[name] ?? env(name);
    if (v === undefined) {
      unresolved.push(name);
      return m;
    }
    return JSON.stringify(v).slice(1, -1); // JSON-escape inside the string literal
  });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `${relPath} is not valid JSON: ${errMsg(e)}` };
  }
  const isWrapped = parsed && typeof parsed === 'object' && 'manifest' in parsed;
  const manifest = isWrapped ? parsed.manifest : parsed;
  // TrueForge can't preload git skills, and reading SKILL.md through the sandbox costs several agent steps.
  // Inline each attached skill's SKILL.md (+ references) into the instructions; the skill still ships the scripts.
  for (const sk of manifest?.skills ?? []) {
    const dir = resolve(REPO_ROOT, 'skills', sk.name);
    if (!existsSync(resolve(dir, 'SKILL.md'))) continue;
    const body = readFileSync(resolve(dir, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
    const refDir = resolve(dir, 'references');
    const refs = existsSync(refDir)
      ? readdirSync(refDir).filter((f) => f.endsWith('.md')).sort()
          .map((f) => `\n\n### references/${f}\n\n${readFileSync(resolve(refDir, f), 'utf8')}`).join('')
      : '';
    manifest.instructions = `${manifest.instructions ?? ''}\n\n## Skill "${sk.name}" (inlined; its files are already at /opt/tf/skills/${sk.name}: don't read SKILL.md or references again)\n\n${body}${refs}`;
  }
  if (!manifest?.model?.name) return { ok: false, error: `${relPath} has no model.name` };
  return {
    ok: true,
    agent: {
      name: (isWrapped && parsed.name) || fallbackName,
      description: (isWrapped && parsed.description) || `Migration Rehearsal agent (${fallbackName})`,
      manifest,
      unresolved: [...new Set(unresolved)],
    },
  };
}
