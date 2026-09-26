"""Plumbing only: throwaway Postgres in the sandbox. boot() -> DSN of a fresh, empty database.
Strategy: (1) pip `pgserver` (x86_64), (2) system/apt Postgres binaries, (3) clear error.
    import sys; sys.path.insert(0, "/opt/tf/skills/migration-rehearsal/scripts")
    from pg_boot import boot, create_from_schema, load_rows"""
import fcntl, glob, json, os, re, shutil, subprocess, time
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

HOME, PORT = "/tmp/dr_pg", 54329

def _sh(cmd, user=None):
    if user and os.geteuid() == 0:
        cmd = ["runuser", "-u", user, "--"] + cmd
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def _server():
    """Return an admin DSN for a running server, starting one if needed (reused across scripts).
    A file lock makes a background warm-up and a later script wait for each other instead of both installing."""
    base = f"postgresql://postgres@127.0.0.1:{PORT}/postgres"
    try: psycopg.connect(base, connect_timeout=2).close(); return base
    except psycopg.OperationalError: pass
    with open("/tmp/dr_pg.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try: psycopg.connect(base, connect_timeout=2).close(); return base
        except psycopg.OperationalError: return _start(base)

def _start(base):
    errors = []
    try:  # (1) embedded binaries from pip; verify it really answers before trusting it
        import pgserver
        uri = pgserver.get_server(f"{HOME}/pgserver", cleanup_mode=None).get_uri()
        psycopg.connect(uri, connect_timeout=5).close(); return uri
    except Exception as e:
        errors.append(f"pgserver: {e!r}"[:300])
    bins = sorted(glob.glob("/usr/lib/postgresql/*/bin/initdb"))
    if not bins:  # (2) apt-install system Postgres (root or passwordless sudo)
        apt = ([] if os.geteuid() == 0 else ["sudo", "-n"]) + ["apt-get", "-qq"]
        env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
        try:
            for args in (["update"], ["install", "-y", "--no-install-recommends", "postgresql"]):
                subprocess.run(apt + args, check=True, capture_output=True, env=env)
            bins = sorted(glob.glob("/usr/lib/postgresql/*/bin/initdb"))
        except Exception as e:
            errors.append(f"apt: {e!r} {getattr(e, 'stderr', b'')[-300:]!r}")
    if not bins:
        raise RuntimeError("No Postgres available in sandbox. Tried: " + " | ".join(errors))
    bindir, data, user = os.path.dirname(bins[-1]), f"{HOME}/data", ("postgres" if os.geteuid() == 0 else None)
    shutil.rmtree(data, ignore_errors=True); os.makedirs(data)
    for d in (HOME, data) if user else (): shutil.chown(d, user)
    _sh([f"{bindir}/initdb", "-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8"], user)
    opts = f"-p {PORT} -c listen_addresses=127.0.0.1 -k {HOME} -c fsync=off -c full_page_writes=off"
    _sh([f"{bindir}/pg_ctl", "-D", data, "-o", opts, "-l", f"{HOME}/pg.log", "-w", "start"], user)
    return base

def boot(dbname="rehearsal"):
    """Start (or reuse) the server; DROP + CREATE `dbname`; return its DSN. Call again for a clean slate."""
    t, admin = time.time(), _server()
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(dbname)))
        c.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
    print(f"[pg_boot] {dbname} ready in {time.time() - t:.1f}s")
    return make_conninfo(admin, dbname=dbname)

def create_from_schema(dsn, schema):
    """Build tables from pgwarden describe_schema output (dict or JSON str): create_sql in FK order, then index_sql."""
    tables = {t["name"]: t for t in (json.loads(schema) if isinstance(schema, str) else schema)["tables"]}
    order, seen = [], set()
    def visit(n):
        if n in seen or n not in tables: return
        seen.add(n)
        for fk in tables[n].get("foreign_keys", []): visit(fk["ref_table"])
        order.append(n)
    for n in sorted(tables): visit(n)
    with psycopg.connect(dsn, autocommit=True) as c:
        for n in order:
            for seq in re.findall(r"nextval\('([^']+)'", tables[n]["create_sql"]):
                c.execute(f"CREATE SEQUENCE IF NOT EXISTS {seq.split('::')[0]}")
            c.execute(tables[n]["create_sql"])
        for n in order:
            for ix in tables[n].get("index_sql", []): c.execute(ix)
    return order

def load_rows(dsn, table, columns, rows):
    """COPY rows (list of lists, e.g. export_table pages) into table; then bump serial sequences past max(id)."""
    with psycopg.connect(dsn) as c, c.cursor() as cur:
        q = sql.SQL("COPY {} ({}) FROM STDIN").format(sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, columns)))
        with cur.copy(q) as cp:
            for r in rows: cp.write_row(r)
        cur.execute("SELECT column_name, substring(column_default from 'nextval\\(''([^'']+)''') FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name=%s AND column_default LIKE 'nextval(%%'", (table,))
        for col, seq in cur.fetchall():
            cur.execute(sql.SQL("SELECT setval(%s, coalesce((SELECT max({}) FROM {}), 0) + 1, false)").format(
                sql.Identifier(col), sql.Identifier(table)), (seq,))
    return len(rows)
