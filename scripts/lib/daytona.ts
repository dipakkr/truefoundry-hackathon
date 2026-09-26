// Delete TrueForge's leftover Daytona sandboxes so the org's disk quota (30 GiB on the free tier) never fills up.
// Only touches stopped/archived/errored sandboxes built from TrueForge's snapshot (`trueforge-build-*`).
import { env, errMsg } from './common.js';

const API = 'https://app.daytona.io/api';

export async function cleanupSandboxes(): Promise<{ deleted: number; kept: number; error?: string }> {
  const key = env('DAYTONA_API_KEY');
  if (!key) return { deleted: 0, kept: 0, error: 'DAYTONA_API_KEY not set' };
  const headers = { Authorization: `Bearer ${key}` };
  try {
    const res = await fetch(`${API}/sandbox`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { deleted: 0, kept: 0, error: `list sandboxes: HTTP ${res.status}` };
    const body = (await res.json()) as unknown;
    const items = (Array.isArray(body) ? body : ((body as { items?: unknown[] }).items ?? [])) as Array<{ id: string; state?: string; snapshot?: string }>;
    const ours = items.filter((s) => (s.snapshot ?? '').startsWith('trueforge-build-'));
    const idle = ours.filter((s) => ['stopped', 'archived', 'error', 'build_failed'].includes(s.state ?? ''));
    let deleted = 0;
    for (const s of idle) {
      const d = await fetch(`${API}/sandbox/${s.id}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(20_000) });
      if (d.ok) deleted++;
    }
    return { deleted, kept: ours.length - deleted };
  } catch (e) {
    return { deleted: 0, kept: 0, error: errMsg(e) };
  }
}
