"""Effects snapshot + diff (CONTRACTS section 7). Same rules as pgwarden's server-side check.

    import sys; sys.path.insert(0, "/opt/tfy/skills/migration-rehearsal/scripts")
    from effects import snapshot, diff
    before = snapshot(dsn); ...run migration...; effects = diff(before, snapshot(dsn))

Never hand-compute effects: apply_migration rolls back unless declared == actual.
Self-test: python effects.py --selftest ../references/effects-golden.json
"""
import copy
import json
import sys

EXCLUDED = {"schema_migrations"}


def snapshot(dsn):
    """Return facts {"tables": {t: {row_count, columns: {c: {type, nullable}}, indexes: [..], constraints: [..]}}}."""
    import psycopg
    from psycopg import sql
    tables = {}
    with psycopg.connect(dsn, autocommit=True) as conn:
        cur = conn.cursor()
        cur.execute("""SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1""")
        for (t,) in cur.fetchall():
            if t in EXCLUDED:
                continue
            cur.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier("public", t)))
            row_count = cur.fetchone()[0]
            cur.execute("""SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull
                           FROM pg_attribute a WHERE a.attrelid = %s::regclass AND a.attnum > 0
                           AND NOT a.attisdropped ORDER BY a.attnum""", (f'public."{t}"',))
            columns = {c: {"type": ty, "nullable": nul} for c, ty, nul in cur.fetchall()}
            cur.execute("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=%s ORDER BY 1", (t,))
            indexes = [r[0] for r in cur.fetchall()]
            # contype 'n' = NOT NULL constraints (PG18+); nullability is tracked on columns instead.
            cur.execute("""SELECT conname FROM pg_constraint WHERE conrelid = %s::regclass
                           AND contype <> 'n' ORDER BY 1""", (f'public."{t}"',))
            constraints = [r[0] for r in cur.fetchall()]
            tables[t] = {"row_count": row_count, "columns": columns,
                         "indexes": indexes, "constraints": constraints}
    return {"tables": tables}


def _b(v):
    return "true" if v else "false"


def diff(before, after):
    """Return {"row_deltas": {t: int}, "schema_changes": sorted [str]} per CONTRACTS section 7."""
    bt = {k: v for k, v in before["tables"].items() if k not in EXCLUDED}
    at = {k: v for k, v in after["tables"].items() if k not in EXCLUDED}
    names = sorted(set(bt) | set(at))
    row_deltas = {t: (at[t]["row_count"] if t in at else 0) - (bt[t]["row_count"] if t in bt else 0)
                  for t in names}
    ch = []
    for t in names:
        if t not in bt:
            ch.append(f"+table:{t}")
            continue
        if t not in at:
            ch.append(f"-table:{t}")
            continue
        bc, ac = bt[t]["columns"], at[t]["columns"]
        for c in set(ac) - set(bc):
            ch.append(f"+column:{t}.{c}")
        for c in set(bc) - set(ac):
            ch.append(f"-column:{t}.{c}")
        for c in set(bc) & set(ac):
            if bc[c]["type"] != ac[c]["type"]:
                ch.append(f"~column:{t}.{c}:{bc[c]['type']}->{ac[c]['type']}")
            if bool(bc[c]["nullable"]) != bool(ac[c]["nullable"]):
                ch.append(f"~nullable:{t}.{c}:{_b(bc[c]['nullable'])}->{_b(ac[c]['nullable'])}")
        for kind, key in (("index", "indexes"), ("constraint", "constraints")):
            b, a = set(bt[t].get(key, [])), set(at[t].get(key, []))
            ch += [f"+{kind}:{t}.{n}" for n in a - b] + [f"-{kind}:{t}.{n}" for n in b - a]
    return {"row_deltas": row_deltas, "schema_changes": sorted(ch)}


def same_effects(x, y):
    """Comparison rule: row_deltas exact per key, schema_changes as a set."""
    return x["row_deltas"] == y["row_deltas"] and set(x["schema_changes"]) == set(y["schema_changes"])


def _patch(facts, ops):
    f = copy.deepcopy(facts)
    for op in ops:
        t = f["tables"].get(op["table"])
        kind = op["op"]
        if kind == "set_rows":
            t["row_count"] = op["row_count"]
        elif kind == "add_index":
            t["indexes"].append(op["name"])
        elif kind == "add_column":
            t["columns"][op["column"]] = {"type": op["type"], "nullable": op["nullable"]}
        elif kind == "rename_column":
            t["columns"][op["to"]] = t["columns"].pop(op["from"])
        elif kind == "drop_table":
            del f["tables"][op["table"]]
        elif kind == "alter_column":
            col = t["columns"][op["column"]]
            col.update({k: op[k] for k in ("type", "nullable") if k in op})
        else:
            raise ValueError(f"unknown patch op {kind}")
    return f


def selftest(path):
    golden = json.load(open(path))
    failed = 0
    for case in golden["cases"]:
        before = golden["base"] if case["before"] == "base" else case["before"]
        got = diff(before, _patch(before, case["patch"]))
        ok = got == case["expected"]  # stricter than same_effects: also checks sort order
        failed += not ok
        print(("PASS" if ok else "FAIL"), case["name"], "" if ok else f"\n  got      {got}\n  expected {case['expected']}")
    print(f"{len(golden['cases']) - failed}/{len(golden['cases'])} cases passed")
    return failed == 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--selftest":
        sys.exit(0 if selftest(sys.argv[2]) else 1)
    if len(sys.argv) == 2:
        print(json.dumps(snapshot(sys.argv[1]), indent=2))
        sys.exit(0)
    print("usage: effects.py --selftest <golden.json> | effects.py <dsn>", file=sys.stderr)
    sys.exit(2)
