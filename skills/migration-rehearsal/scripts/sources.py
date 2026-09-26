"""Data movement for rehearsals, for use inside Code Mode (sandbox).

Only I/O plumbing: pull full masked tables from pgwarden and read files from GitHub.
The rehearsal logic (running the migration, checks, report, fix) is written by the agent.
"""
import ast
import json
import re

from mcp_client import call_tool


def _text(item):
    """Text of one MCP content item: pydantic object, dict, or its string repr."""
    if isinstance(item, str):
        m = re.search(r"""text=('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")""", item)
        return ast.literal_eval(m.group(1)) if m else item
    res = getattr(item, "resource", None) or (item.get("resource") if isinstance(item, dict) else None)
    if res is not None:
        return getattr(res, "text", None) or (res.get("text") if isinstance(res, dict) else None)
    return getattr(item, "text", None) or (item.get("text") if isinstance(item, dict) else None)


async def export_tables(tables, page_size=5000, server="pgwarden"):
    """Full masked copy of each table: {table: (columns, rows)}. Asserts nothing was dropped.
    `server` is the pgwarden MCP server name for this project (one pgwarden per onboarded project)."""
    out = {}
    for t in tables:
        rows, page, cols, total = [], 0, None, None
        while True:
            r = await call_tool(server, "export_table", body={"table": t, "page": page, "page_size": page_size})
            if isinstance(r, str):
                r = json.loads(r)
            cols, total = r["columns"], r["total_rows"]
            rows += r["rows"]
            page += 1
            if not r["has_more"]:
                break
        assert len(rows) == total, f"{t}: exported {len(rows)} of {total} rows"
        out[t] = (cols, rows)
    return out


async def read_file(owner, repo, path, ref):
    """Text content of a file in the repo at `ref` (branch name, e.g. 'feat/x')."""
    ref = ref if ref.startswith("refs/") else f"refs/heads/{ref}"
    data = await call_tool("github", "get_file_contents", body={"owner": owner, "repo": repo, "path": path, "ref": ref})
    items = data if isinstance(data, list) else [data]
    for item in reversed(items):
        text = _text(item)
        if text and not text.startswith("successfully downloaded"):
            return text
    raise RuntimeError(f"no file text in get_file_contents result for {path}: {str(data)[:300]}")


async def list_dir(owner, repo, path, ref):
    """File paths directly under `path` in the repo at `ref`."""
    ref = ref if ref.startswith("refs/") else f"refs/heads/{ref}"
    data = await call_tool("github", "get_file_contents", body={"owner": owner, "repo": repo, "path": path, "ref": ref})
    items = data if isinstance(data, list) else [data]
    # Usual shape: a list of GitHub content entries ({type, name, path, ...}).
    if items and all(isinstance(e, dict) and "path" in e for e in items):
        return [e["path"] for e in items if e.get("type", "file") == "file"]
    for item in items:  # fallback: entries JSON-encoded inside a text item
        try:
            entries = json.loads(_text(item) or "")
        except (ValueError, TypeError):
            continue
        if isinstance(entries, list):
            return [e.get("path") or f"{path}/{e['name']}" for e in entries if e.get("type", "file") == "file"]
    raise RuntimeError(f"no directory listing in get_file_contents result for {path}: {str(data)[:300]}")


async def read_dir(owner, repo, path, ref, suffix=".sql"):
    """{path: text} for every file under `path` ending with `suffix`."""
    return {p: await read_file(owner, repo, p, ref) for p in await list_dir(owner, repo, path, ref) if p.endswith(suffix)}
