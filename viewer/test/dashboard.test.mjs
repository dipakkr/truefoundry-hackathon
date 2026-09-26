// node --test viewer/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapEvents } from "../public/mapEvents.mjs";
import { outcomeOf, repoPrFromText, median, sessionRow, aggregate, floorHour } from "../public/dashboard.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/sample-session.json", import.meta.url), "utf8"));
const HOUR = 3600e3;

test("outcomeOf buckets every mapper status", () => {
  const k = (status) => outcomeOf({ status }).key;
  assert.equal(k("applied · verified"), "applied");
  assert.equal(k("applied"), "applied");
  assert.equal(outcomeOf({ status: "applied · verified" }).label, "applied · verified");
  assert.equal(k("denied · prod unchanged"), "denied");
  assert.equal(k("refused by server (REHEARSAL_NOT_FOUND)"), "refused");
  assert.equal(outcomeOf({ status: "refused by server (REHEARSAL_NOT_FOUND)" }).code, "REHEARSAL_NOT_FOUND");
  assert.equal(k("waiting for approval"), "waiting");
  assert.equal(k("paused"), "waiting");
  assert.equal(k("running"), "running");
  assert.equal(k("error"), "error");
  assert.equal(k("done"), "noapply");
  assert.equal(k("no events"), "noapply");
});

test("repoPrFromText reads repo and PR from the prompt", () => {
  assert.deepEqual(repoPrFromText("Rehearse PR #2 in `dipakkr/shopkart` against prod "), { repo: "dipakkr/shopkart", pr: 2, url: "https://github.com/dipakkr/shopkart/pull/2" });
  assert.deepEqual(repoPrFromText("hello"), { repo: null, pr: null, url: null });
});

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("sessionRow on the fixture: approvals, sandbox runs, gated call result", () => {
  const m = mapEvents(fixture.events);
  const row = sessionRow(fixture.session, m);
  assert.equal(row.id, fixture.session.id);
  assert.equal(row.toolCalls, m.summary.toolCalls);
  assert.equal(row.tokens, m.summary.tokens);
  assert.equal(row.sandboxRuns, m.observations.filter((o) => o.type === "SPAN" && o.meta.system_tool === "exec").length);
  const appr = m.observations.filter((o) => o.type === "APPROVAL");
  assert.equal(row.approvals.length, appr.length);
  for (const a of row.approvals) {
    if (a.decision !== "pending") { assert.ok(a.waitMs >= 0); assert.ok(a.result === null || typeof a.result.status === "string"); }
  }
  assert.equal(row.outcome.key, outcomeOf(m.summary).key);
});

// Synthetic rows shaped like the live demo data: 7 rehearsals + 1 naive + 1 inline probe.
function row(id, agent, key, { createdAt, approvals = [], tokens = 100 } = {}) {
  const first = approvals.find((a) => a.cardMs != null);
  return { id, agent, isRehearsal: agent === "migration-rehearsal", outcome: { key }, createdAt, tokens, ttaMs: first ? first.cardMs : null, pending: approvals.filter((a) => a.decision === "pending").length, approvals: approvals.map((a) => ({ sessionId: id, ...a })) };
}

test("aggregate: KPIs count only migration-rehearsal runs, median time to approval card per run", () => {
  const now = Date.UTC(2026, 8, 26, 8, 30);
  const t = (min) => now - min * 60e3;
  const rows = [
    row("a", "migration-rehearsal", "refused", { createdAt: t(100), approvals: [{ decision: "allow", waitMs: 2691714, cardMs: 150000, requestedAt: t(99) }, { decision: "allow", waitMs: 1077758, cardMs: 40000, requestedAt: t(40) }] }),
    row("b", "migration-rehearsal", "denied", { createdAt: t(92), approvals: [{ decision: "deny", waitMs: 286787, cardMs: 170000, requestedAt: t(90) }] }),
    row("c", "migration-rehearsal", "applied", { createdAt: t(105), approvals: [{ decision: "allow", waitMs: 736, cardMs: 140000, requestedAt: t(104) }] }),
    row("d", "migration-rehearsal", "denied", { createdAt: t(111), approvals: [{ decision: "deny", waitMs: 913, cardMs: 160000, requestedAt: t(110) }] }),
    row("e", "migration-rehearsal", "error", { createdAt: t(113) }),
    row("f", "migration-rehearsal", "noapply", { createdAt: t(118) }),
    row("g", "migration-rehearsal", "noapply", { createdAt: t(123) }),
    row("n", "migration-rehearsal-naive", "applied", { createdAt: t(10), tokens: 99999 }),
    row("x", "–", "noapply", { createdAt: t(117), tokens: 99999 }),
  ];
  const { kpis, hours, tta, outOfRange } = aggregate(rows, { now });
  assert.deepEqual(
    { runs: kpis.runs, applied: kpis.applied, denied: kpis.denied, refused: kpis.refused, error: kpis.error, noapply: kpis.noapply, pending: kpis.pendingApprovals },
    { runs: 7, applied: 1, denied: 2, refused: 1, error: 1, noapply: 2, pending: 0 },
  );
  assert.equal(kpis.ttaN, 4);
  assert.equal(kpis.medianTtaMs, 155000);
  assert.equal(kpis.tokens, 700);
  // 6 hourly buckets ending at the current hour; all runs land in range
  assert.equal(hours.length, 6);
  assert.equal(hours[hours.length - 1].t, floorHour(now));
  assert.equal(new Date(hours[0].t).getMinutes(), 0); // local clock hours
  assert.equal(outOfRange, 0);
  assert.equal(hours.reduce((n, h) => n + h.total, 0), 7);
  // time-to-card series: one bar per run (its first approval), ordered by request time
  assert.equal(tta.length, 4);
  assert.deepEqual(tta.map((x) => x.sessionId), ["d", "c", "a", "b"]);
  assert.deepEqual(tta.map((x) => x.waitMs), [160000, 140000, 150000, 170000]);
});

test("aggregate: hour axis is capped at maxHours and counts out-of-range runs", () => {
  const now = Date.UTC(2026, 8, 26, 12, 30);
  const rows = [row("old", "migration-rehearsal", "applied", { createdAt: now - 72 * HOUR }), row("new", "migration-rehearsal", "denied", { createdAt: now - HOUR })];
  const { hours, outOfRange } = aggregate(rows, { now, maxHours: 24 });
  assert.equal(hours.length, 24);
  assert.equal(outOfRange, 1);
  assert.equal(hours.at(-2).counts.denied, 1);
});

test("pending approval: row is waiting, KPI counts it, time to card is known before the decision", () => {
  const chrono = fixture.events.slice().reverse();
  const cut = chrono.findIndex((e) => e.event.type === "turn.created" && e.turn_id === fixture.turns[0].id);
  const row = sessionRow(fixture.session, mapEvents(chrono.slice(0, cut)));
  assert.equal(row.outcome.key, "waiting");
  assert.equal(row.pending, 1);
  assert.equal(row.approvals[0].decision, "pending");
  assert.equal(row.approvals[0].waitMs, null);
  assert.equal(row.approvals[0].result, null);
  assert.ok(row.approvals[0].cardMs > 0);
  assert.equal(row.ttaMs, row.approvals[0].cardMs);
  const decided = sessionRow({ ...fixture.session, id: "done" }, mapEvents(fixture.events));
  const { kpis, tta } = aggregate([row, decided], { now: Date.parse(fixture.session.created_at) + 3600e3 });
  assert.equal(kpis.pendingApprovals, 1);
  assert.equal(kpis.ttaN, 2);
  assert.equal(tta.length, 2);
});
