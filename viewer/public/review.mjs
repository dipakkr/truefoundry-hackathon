// Review assist for the approval card: a plain-English reading of what an apply_migration call will do,
// with risk flags and a recommendation. Deterministic (no model): computed from the SQL, the declared effects
// and the project's protected tables, so it is independent of the agent's own evidence_summary.
// Pure: shared by the browser (app.js) and `node --test`.

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const ident = (s) => (s || "").replace(/"/g, "").replace(/^public\./, "");

/** Split on top-level semicolons (skips quoted strings and dollar-quoted bodies). */
export function splitStatements(sql) {
  const src = stripComments(sql);
  const out = [];
  let cur = "", i = 0, q = null;
  while (i < src.length) {
    const ch = src[i];
    if (q) {
      if (src.startsWith(q, i)) { cur += q; i += q.length; q = null; continue; }
      cur += ch; i++; continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
    if (dollar) { q = dollar[0]; cur += q; i += q.length; continue; }
    if (ch === "'") { q = "'"; cur += ch; i++; continue; }
    if (ch === ";") { if (oneLine(cur)) out.push(oneLine(cur)); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  if (oneLine(cur)) out.push(oneLine(cur));
  return out;
}

/** One statement → { text, risk: "low" | "medium" | "high" | "blocked", data: bool }. */
export function describeStatement(s) {
  let m;
  const notValid = /\bNOT\s+VALID\b/i.test(s);
  if ((m = /^DELETE\s+FROM\s+([\w."]+)/i.exec(s)))
    return { text: `Deletes rows from ${ident(m[1])}${/\bUSING\b/i.test(s) ? " (matched against other rows)" : ""}. Anything with ON DELETE CASCADE goes too.`, risk: "high", data: true };
  if ((m = /^UPDATE\s+([\w."]+)/i.exec(s)))
    return { text: `Changes values in ${ident(m[1])}. Row counts can't show value changes, so read this statement yourself.`, risk: "medium", data: true };
  if ((m = /^INSERT\s+INTO\s+([\w."]+)/i.exec(s)))
    return { text: `Adds rows to ${ident(m[1])}.`, risk: "medium", data: true };
  if (/^(DROP|TRUNCATE)\b/i.test(s) || /\bDROP\s+COLUMN\b|\bRENAME\b/i.test(s))
    return { text: `Destructive (${oneLine(s).split(" ").slice(0, 3).join(" ")}): pgwarden policy refuses this even with approval.`, risk: "blocked", data: true };
  if ((m = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)?\s*ON\s+([\w."]+)\s*(?:USING\s+\w+\s*)?\(([^)]*)\)(?:\s*WHERE\s+(.+))?/i.exec(s)))
    return { text: `Adds ${m[1] ? "a unique " : "an "}index on ${ident(m[3])}(${m[4].trim()})${m[5] ? `, only for rows where ${m[5].trim()}` : ""}${m[1] ? ": new duplicates will be rejected" : ""}. Blocks writes to ${ident(m[3])} while it builds.`, risk: "low", data: false };
  if ((m = /^ALTER\s+TABLE\s+(?:ONLY\s+)?([\w."]+)\s+(.+)$/i.exec(s))) {
    const t = ident(m[1]), rest = m[2];
    let c;
    if ((c = /ADD\s+CONSTRAINT\s+([\w"]+)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([\w."]+)/i.exec(rest)))
      return notValid
        ? { text: `Requires ${t}.${c[2].trim()} to point at an existing ${ident(c[3])} row, for new and updated rows only (existing rows are not checked).`, risk: "low", data: false }
        : { text: `Adds a foreign key ${t}.${c[2].trim()} → ${ident(c[3])} and checks every existing row (full scan; fails if any row breaks it).`, risk: "medium", data: false };
    if ((c = /ADD\s+CONSTRAINT\s+([\w"]+)\s+CHECK\s*\((.+)\)/i.exec(rest)))
      return notValid
        ? { text: `Adds the rule ${oneLine(c[2]).replace(/\)\s*NOT VALID$/i, "")} on ${t}, for new and updated rows only.`, risk: "low", data: false }
        : { text: `Adds the rule ${oneLine(c[2])} on ${t} and checks every existing row.`, risk: "medium", data: false };
    if ((c = /ADD\s+CONSTRAINT\s+([\w"]+)\s+UNIQUE\s*\(([^)]*)\)/i.exec(rest)))
      return { text: `Makes ${t}(${c[2].trim()}) unique across all rows (builds an index; fails if duplicates exist).`, risk: "medium", data: false };
    if ((c = /ALTER\s+COLUMN\s+([\w"]+)\s+SET\s+NOT\s+NULL/i.exec(rest)))
      return { text: `Makes ${t}.${ident(c[1])} required. Scans every row and fails if any is empty.`, risk: "medium", data: false };
    if ((c = /ALTER\s+COLUMN\s+([\w"]+)\s+(?:SET\s+DATA\s+)?TYPE\s+(\S+)/i.exec(rest)))
      return { text: `Changes the type of ${t}.${ident(c[1])} to ${c[2]}. Rewrites the table, and values may be converted or rounded.`, risk: "high", data: true };
    if ((c = /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)\s+([\w()]+)/i.exec(rest)) && !/^ADD\s+CONSTRAINT/i.test(rest))
      return { text: `Adds column ${t}.${ident(c[1])} (${c[2]})${/NOT\s+NULL/i.test(rest) ? ", required" : ""}${/DEFAULT/i.test(rest) ? ", with a default" : ""}.`, risk: /NOT\s+NULL/i.test(rest) && !/DEFAULT/i.test(rest) ? "medium" : "low", data: false };
    if ((c = /VALIDATE\s+CONSTRAINT\s+([\w"]+)/i.exec(rest)))
      return { text: `Checks every existing row of ${t} against ${ident(c[1])} (full scan).`, risk: "medium", data: false };
  }
  if (/^COMMENT\s+ON\b/i.test(s)) return { text: "Adds a comment. No effect on data.", risk: "low", data: false };
  return { text: `Unrecognised statement: ${s.slice(0, 80)}${s.length > 80 ? "…" : ""}`, risk: "medium", data: true };
}

/**
 * @param {{sql?: string, effects?: {row_deltas?: Record<string, number>, schema_changes?: string[]}, protectedTables?: string[]}} input
 * @returns {{verdict: "allow"|"review"|"deny", headline: string, reasons: string[], statements: ReturnType<typeof describeStatement>[]}}
 */
export function reviewMigration({ sql = "", effects = {}, protectedTables = [] } = {}) {
  const statements = splitStatements(sql).map(describeStatement);
  const deltas = effects.row_deltas || {};
  const reasons = [];
  const lostProtected = protectedTables.filter((t) => (deltas[t] ?? 0) < 0);
  const lostOther = Object.keys(deltas).filter((t) => deltas[t] < 0 && !protectedTables.includes(t));
  const added = Object.keys(deltas).filter((t) => deltas[t] > 0);
  for (const t of lostProtected) reasons.push(`Removes ${-deltas[t]} row(s) from ${t}, a protected (append-only) table. pgwarden will refuse this even if you allow it.`);
  for (const t of lostOther) reasons.push(`Removes ${-deltas[t]} row(s) from ${t}. Make sure every one of them should really go.`);
  for (const t of added) reasons.push(`Adds ${deltas[t]} row(s) to ${t}.`);
  if (statements.some((s) => s.risk === "blocked")) reasons.push("Contains a statement pgwarden's policy refuses (DROP / TRUNCATE / RENAME / DROP COLUMN).");
  if (statements.some((s) => /Changes values/.test(s.text))) reasons.push("Rewrites values with UPDATE: the effects only count rows, so a wrong value change would not show up in the numbers.");
  const noRowChange = Object.values(deltas).every((d) => d === 0);
  const writes = statements.some((s) => s.data);
  let verdict, headline;
  if (lostProtected.length || statements.some((s) => s.risk === "blocked")) {
    verdict = "deny";
    headline = "Deny: this would destroy protected data or use a forbidden statement.";
  } else if (lostOther.length || writes || statements.some((s) => s.risk === "high")) {
    verdict = "review";
    headline = noRowChange ? "Review carefully: it writes data, even though no row counts change." : "Review carefully: it changes existing data.";
  } else {
    verdict = "allow";
    headline = noRowChange ? "Low risk: adds rules and indexes only. No existing row is changed or removed." : "Low risk: schema only.";
    if (statements.some((s) => s.risk === "medium")) {
      verdict = "review";
      headline = "Probably safe, but some steps scan or lock whole tables. Check the table sizes.";
    }
  }
  return { verdict, headline, reasons, statements };
}
