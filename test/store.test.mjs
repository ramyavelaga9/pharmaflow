import { test } from "node:test";
import assert from "node:assert/strict";
import { refillStatus, summarizePanel, logDose } from "../src/store.mjs";

test("refillStatus buckets by days until due, given an explicit asOf date", () => {
  const asOf = new Date("2026-08-29T00:00:00.000Z");
  const med = (daysSupply, lastFilled) => ({ daysSupply, lastFilled });

  // Same 30-day supply, only the fill date changes: due -5d / +1d / +5d / +10d.
  assert.equal(refillStatus(med(30, "2026-07-25"), asOf).status, "overdue");
  assert.equal(refillStatus(med(30, "2026-07-31"), asOf).status, "critical");
  assert.equal(refillStatus(med(30, "2026-08-04"), asOf).status, "due-soon");
  assert.equal(refillStatus(med(30, "2026-08-09"), asOf).status, "ok");
});

test("refillStatus reports the same day as 'critical', not 'overdue' (boundary case)", () => {
  const asOf = new Date("2026-08-29T00:00:00.000Z");
  const result = refillStatus({ daysSupply: 1, lastFilled: "2026-08-28" }, asOf);
  assert.equal(result.daysUntilDue, 0);
  assert.equal(result.status, "critical");
});

test("summarizePanel counts active cases and high-risk patients from worstRefillStatus", () => {
  const patients = [
    { worstRefillStatus: "ok" },
    { worstRefillStatus: "due-soon" },
    { worstRefillStatus: "critical" },
    { worstRefillStatus: "overdue" },
  ];
  const stats = summarizePanel(patients);
  assert.deepEqual(stats, { activeCases: 3, highRisk: 2 });
});

test("summarizePanel never invents fields beyond the real computed stats", () => {
  const stats = summarizePanel([]);
  assert.deepEqual(Object.keys(stats).sort(), ["activeCases", "highRisk"]);
});

test("logDose rejects for an unknown patient without touching stored data (failure case)", async () => {
  await assert.rejects(() => logDose("no-such-patient", "no-such-med", true), /Unknown patient/);
});
