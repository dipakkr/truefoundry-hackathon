// Deterministic "prod" seed for shopkart (CONTRACTS §3).
// npm run seed  -> applies seed/schema.sql, then inserts 5,014 users + 20,000 orders.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import pg from "pg";

const SEED = 20260926;
const UNIQUE_USERS = 5000;
const DUP_GROUPS = 14;
const TOTAL_ORDERS = 20000;
const DAY_MS = 86_400_000;
// Fixed "now" so the data is identical on every run (demo date).
const NOW = Date.UTC(2026, 8, 26, 9, 0, 0);
const SPAN_MS = 548 * DAY_MS; // ~18 months

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const FIRST = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Ayaan", "Krishna", "Ishaan",
  "Rohan", "Rahul", "Amit", "Vikram", "Karan", "Siddharth", "Nikhil", "Manish", "Suresh", "Ramesh",
  "Deepak", "Anil", "Sanjay", "Rajesh", "Harsh", "Kunal", "Varun", "Gaurav", "Abhishek", "Naveen",
  "Priya", "Ananya", "Diya", "Aadhya", "Saanvi", "Isha", "Kavya", "Meera", "Neha", "Pooja",
  "Sneha", "Riya", "Shreya", "Anjali", "Divya", "Lakshmi", "Swati", "Nisha", "Aishwarya", "Tanvi",
  "Radhika", "Sunita", "Kiran", "Pallavi", "Aditi", "Bhavna", "Jyoti", "Madhuri", "Nandini", "Shalini",
];
const LAST = [
  "Sharma", "Verma", "Gupta", "Singh", "Kumar", "Patel", "Shah", "Mehta", "Iyer", "Nair",
  "Reddy", "Rao", "Naidu", "Pillai", "Menon", "Joshi", "Kulkarni", "Deshpande", "Patil", "Chopra",
  "Kapoor", "Malhotra", "Bansal", "Agarwal", "Jain", "Das", "Banerjee", "Chatterjee", "Mukherjee", "Bose",
  "Ghosh", "Sen", "Mishra", "Pandey", "Tiwari", "Yadav", "Chauhan", "Thakur", "Saxena", "Srivastava",
];
const CITIES = [
  "Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Chennai", "Kolkata", "Pune", "Ahmedabad", "Jaipur",
  "Lucknow", "Kochi", "Chandigarh", "Indore", "Bhopal", "Nagpur", "Surat", "Coimbatore", "Mysuru",
  "Visakhapatnam", "Guwahati",
];
const DOMAINS = [
  ...Array(5).fill("gmail.com"), ...Array(2).fill("yahoo.com"), ...Array(2).fill("outlook.com"),
  "infosys.com", "tcs.com", "wipro.com", "flipkart.com", "zoho.com", "hcl.com",
];
// Dup originals are mixed-case; duplicate rows are the lower-case re-signup.
const DUP_DOMAINS = ["gmail.com", "gmail.com", "yahoo.com", "outlook.com"];

type User = { email: string; full_name: string; phone: string | null; city: string; created_at: number };
type Order = { user_idx: number; amount_paise: number; status: string; created_at: number };

const users: User[] = [];
const seenLower = new Set<string>();

function phone(): string | null {
  if (rand() < 0.1) return null;
  return `+91 9${String(int(0, 999_999_999)).padStart(9, "0")}`;
}

function makeEmail(first: string, last: string, domain: string): string {
  const f = first.toLowerCase(), l = last.toLowerCase();
  const style = int(0, 4);
  const base = [`${f}.${l}`, `${f}${l}`, `${f}_${l}`, `${f[0]}${l}`, `${f}.${l[0]}`][style];
  let email = `${base}@${domain}`;
  while (seenLower.has(email)) email = `${base}${int(1, 999)}@${domain}`;
  return email;
}

// 1) 5,000 unique users, created over the past 18 months (sorted by time => ids follow time).
const userTimes = Array.from({ length: UNIQUE_USERS }, () => NOW - SPAN_MS + Math.floor(rand() * (SPAN_MS - 30 * DAY_MS))).sort((a, b) => a - b);

// Pick which 14 of the original users get a case-variant duplicate (spread through the first ~70%).
const dupOriginalIdx = new Set<number>();
while (dupOriginalIdx.size < DUP_GROUPS) dupOriginalIdx.add(int(50, Math.floor(UNIQUE_USERS * 0.7)));

for (let i = 0; i < UNIQUE_USERS; i++) {
  const first = pick(FIRST), last = pick(LAST);
  let email: string;
  if (dupOriginalIdx.has(i)) {
    // Mixed case original, e.g. Priya.Sharma@gmail.com
    let e = `${first}.${last}@${pick(DUP_DOMAINS)}`;
    while (seenLower.has(e.toLowerCase())) e = `${first}.${last}${int(1, 99)}@${pick(DUP_DOMAINS)}`;
    email = e;
  } else {
    email = makeEmail(first, last, pick(DOMAINS));
  }
  seenLower.add(email.toLowerCase());
  users.push({ email, full_name: `${first} ${last}`, phone: phone(), city: pick(CITIES), created_at: userTimes[i] });
}

// 2) 14 duplicates: lower-cased email, newer than the original, appended after (ids 5001..5014).
const dupPairs: { original: number; dup: number }[] = [];
const dupSources = [...dupOriginalIdx].sort((a, b) => a - b);
const dupTimes = dupSources.map((i) => users[i].created_at + int(20, 200) * DAY_MS).map((t) => Math.min(t, NOW - DAY_MS));
const dupOrder = dupSources.map((src, k) => ({ src, t: dupTimes[k] })).sort((a, b) => a.t - b.t);
for (const { src, t } of dupOrder) {
  const o = users[src];
  users.push({ email: o.email.toLowerCase(), full_name: o.full_name, phone: rand() < 0.5 ? o.phone : phone(), city: o.city, created_at: t });
  dupPairs.push({ original: src, dup: users.length - 1 });
}

// 3) Orders: each duplicate owns 1–3; the rest go to unique users.
const STATUSES = [...Array(7).fill("paid"), ...Array(2).fill("shipped"), "refunded"] as const;
const orders: Order[] = [];
function orderFor(userIdx: number) {
  const u = users[userIdx];
  const t = u.created_at + Math.floor(rand() * (NOW - u.created_at));
  // ₹99 .. ₹24,999, in paise
  const amount = int(99, 24_999) * 100 + (rand() < 0.3 ? 0 : int(1, 99));
  orders.push({ user_idx: userIdx, amount_paise: amount, status: pick(STATUSES), created_at: t });
}
let dupOrders = 0;
for (const { dup } of dupPairs) {
  const n = int(1, 3);
  dupOrders += n;
  for (let k = 0; k < n; k++) orderFor(dup);
}
while (orders.length < TOTAL_ORDERS) orderFor(int(0, UNIQUE_USERS - 1));
orders.sort((a, b) => a.created_at - b.created_at);

// ---- sanity (fail loudly rather than seed something off-contract) ----
const exact = new Set(users.map((u) => u.email));
if (exact.size !== users.length) throw new Error("exact-case duplicate email generated");
if (users.length !== UNIQUE_USERS + DUP_GROUPS || orders.length !== TOTAL_ORDERS) throw new Error("count mismatch");

// ---- write ----
const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "schema.sql"), "utf8");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (repo-root .env)");

const t0 = Date.now();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function insertBatched(table: string, cols: string[], rows: unknown[][], batch = 1000) {
  for (let off = 0; off < rows.length; off += batch) {
    const chunk = rows.slice(off, off + batch);
    const params: unknown[] = [];
    const tuples = chunk.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(",")})`);
    await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`, params);
  }
}

try {
  await client.query("BEGIN");
  await client.query(schemaSql);
  // ids are explicit (1-based, insertion order) so orders can reference them in the same pass.
  await insertBatched(
    "users",
    ["id", "email", "full_name", "phone", "city", "created_at"],
    users.map((u, i) => [i + 1, u.email, u.full_name, u.phone, u.city, new Date(u.created_at).toISOString()]),
  );
  await insertBatched(
    "orders",
    ["id", "user_id", "amount_paise", "status", "created_at"],
    orders.map((o, i) => [i + 1, o.user_idx + 1, o.amount_paise, o.status, new Date(o.created_at).toISOString()]),
  );
  await client.query("SELECT setval('users_id_seq', (SELECT max(id) FROM users))");
  await client.query("SELECT setval('orders_id_seq', (SELECT max(id) FROM orders))");
  await client.query("COMMIT");
  await client.query("ANALYZE users; ANALYZE orders;");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
}

const q = async (sql: string) => Number((await client.query(sql)).rows[0].n);
const summary = {
  users: await q("SELECT count(*) AS n FROM users"),
  orders: await q("SELECT count(*) AS n FROM orders"),
  lower_email_dup_groups: await q("SELECT count(*) AS n FROM (SELECT lower(email) FROM users GROUP BY 1 HAVING count(*) > 1) t"),
  exact_email_dups: await q("SELECT count(*) AS n FROM (SELECT email FROM users GROUP BY 1 HAVING count(*) > 1) t"),
  orders_owned_by_duplicates: await q(
    "SELECT count(*) AS n FROM orders o JOIN users u ON u.id = o.user_id WHERE EXISTS (SELECT 1 FROM users u2 WHERE lower(u2.email) = lower(u.email) AND u2.id < u.id)",
  ),
  null_phones: await q("SELECT count(*) AS n FROM users WHERE phone IS NULL"),
};
await client.end();

if (dupOrders !== summary.orders_owned_by_duplicates) throw new Error("dup order count mismatch");
console.log(`seeded shopkart in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
console.table(summary);
if (process.argv.includes("--pairs")) {
  for (const { original, dup } of dupPairs)
    console.log(`${original + 1}\t${users[original].email}\t${dup + 1}\t${users[dup].email}\t${orders.filter((o) => o.user_idx === dup).length}`);
}
