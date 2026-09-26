"""WS3 plumbing validation (NOT part of the skill). Run inside a Linux container mimicking Daytona:
  tests/skill/run_container.sh [amd64|arm64]
Checks: boot -> create_from_schema -> load_rows (with 2 case-variant duplicate emails) -> snapshot ->
naive unique index on lower(email) FAILS -> dedupe+index+add-column fix -> diff == expected.
"""
import json, random, sys, time

sys.path.insert(0, "/opt/tfy/skills/migration-rehearsal/scripts")
import psycopg
from pg_boot import boot, create_from_schema, load_rows
from effects import snapshot, diff, same_effects, selftest

# --- HAND-WRITTEN stand-in for pgwarden describe_schema output (CONTRACTS section 5 shape) ---
# Mirrors the real shopkart schema (seed/schema.sql). Replace with a live describe_schema capture once WS1 ships.
SCHEMA = {
    "pg_version": "16.x (hand-written stand-in)",
    "tables": [
        {   # listed first on purpose: create_from_schema must reorder by FK
            "name": "orders", "row_estimate": 0,
            "create_sql": "CREATE TABLE public.orders (id bigint NOT NULL DEFAULT nextval('orders_id_seq'::regclass), "
                          "user_id bigint NOT NULL, amount_paise integer NOT NULL, status text NOT NULL, "
                          "created_at timestamp with time zone NOT NULL DEFAULT now(), "
                          "CONSTRAINT orders_pkey PRIMARY KEY (id), "
                          "CONSTRAINT orders_amount_paise_check CHECK ((amount_paise > 0)), "
                          "CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id))",
            "index_sql": ["CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)"],
            "foreign_keys": [{"name": "orders_user_id_fkey", "column": "user_id", "ref_table": "users", "ref_column": "id"}],
        },
        {
            "name": "users", "row_estimate": 0,
            "create_sql": "CREATE TABLE public.users (id bigint NOT NULL DEFAULT nextval('users_id_seq'::regclass), "
                          "email text NOT NULL, full_name text NOT NULL, phone text, city text, "
                          "created_at timestamp with time zone NOT NULL DEFAULT now(), "
                          "CONSTRAINT users_pkey PRIMARY KEY (id))",
            "index_sql": [],
            "foreign_keys": [],
        },
    ],
}

N_USERS, N_ORDERS, DUP_IDS = 3000, 6000, (2999, 3000)
rng = random.Random(20260926)
users = [[i, f"user{i}@gmail.com", f"User {i}", f"98{i:08d}", "Pune", f"2025-01-01T00:00:{i % 60:02d}Z"]
         for i in range(1, N_USERS - 1)]
users += [[2999, "User1@gmail.com", "User 1b", None, "Delhi", "2025-06-01T00:00:00Z"],   # case-variant of user1
          [3000, "USER2@gmail.com", "User 2b", None, "Delhi", "2025-06-01T00:00:00Z"]]   # case-variant of user2
orders = [[i, rng.randint(1, N_USERS), rng.randint(100, 99999), "paid", "2025-07-01T00:00:00Z"] for i in range(1, N_ORDERS + 1)]

ok = True
def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail else ""))

check("effects selftest", selftest("/opt/tfy/skills/migration-rehearsal/references/effects-golden.json"))

t = time.time(); dsn = boot("rehearsal_v1"); boot_s = time.time() - t
with psycopg.connect(dsn) as c:
    ver = c.execute("select version()").fetchone()[0]
print(f"BOOT {boot_s:.2f}s  {ver}")
check("boot < 20s", boot_s < 20, f"{boot_s:.2f}s")

check("create_from_schema FK order", create_from_schema(dsn, json.dumps(SCHEMA)) == ["users", "orders"])
t = time.time()
load_rows(dsn, "users", ["id", "email", "full_name", "phone", "city", "created_at"], users)
load_rows(dsn, "orders", ["id", "user_id", "amount_paise", "status", "created_at"], orders)
print(f"LOAD {len(users)} users + {len(orders)} orders in {time.time() - t:.2f}s")

before = snapshot(dsn)
print("SNAPSHOT users:", json.dumps(before["tables"]["users"]))
check("snapshot types in golden vocabulary",
      before["tables"]["users"]["columns"]["created_at"]["type"] == "timestamp with time zone"
      and before["tables"]["orders"]["columns"]["amount_paise"]["type"] == "integer"
      and before["tables"]["orders"]["constraints"] == ["orders_amount_paise_check", "orders_pkey", "orders_user_id_fkey"])

with psycopg.connect(dsn, autocommit=True) as c:
    try:
        c.execute("CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email))")
        check("naive lower(email) unique index fails", False)
    except psycopg.errors.UniqueViolation as e:
        check("naive lower(email) unique index fails", True, str(e).splitlines()[0])
    # serial sequences must be past max(id) so fix SQL can INSERT
    nxt = c.execute("select nextval('users_id_seq')").fetchone()[0]
    check("sequence bumped past loaded ids", nxt == N_USERS + 1, f"nextval={nxt}")

FIX = """
BEGIN;
WITH ranked AS (
  SELECT id, first_value(id) OVER (PARTITION BY lower(email) ORDER BY created_at, id) AS keep_id FROM users
)
UPDATE orders o SET user_id = r.keep_id FROM ranked r WHERE o.user_id = r.id AND r.id <> r.keep_id;
DELETE FROM users u USING (
  SELECT id, first_value(id) OVER (PARTITION BY lower(email) ORDER BY created_at, id) AS keep_id FROM users
) r WHERE u.id = r.id AND r.id <> r.keep_id;
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));
ALTER TABLE users ADD COLUMN mobile text;
UPDATE users SET mobile = phone;
COMMIT;
"""
with psycopg.connect(dsn, autocommit=True) as c:
    c.execute(FIX)
after = snapshot(dsn)
eff = diff(before, after)
expected = {"row_deltas": {"orders": 0, "users": -2}, "schema_changes": ["+column:users.mobile", "+index:users.users_email_lower_uniq"]}
print("EFFECTS", json.dumps(eff))
check("diff == expected", eff == expected and same_effects(eff, expected))

dsn2 = boot("rehearsal_v2")  # second call: reuses server, fresh DB
with psycopg.connect(dsn2) as c:
    n = c.execute("select count(*) from pg_tables where schemaname='public'").fetchone()[0]
check("boot() again gives a clean DB", n == 0)

print("ALL OK" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
