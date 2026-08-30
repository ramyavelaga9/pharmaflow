import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, utimes, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  refillStatus,
  summarizePanel,
  logDose,
  getRefillAlerts,
  getPatient,
  withPatientsLock,
} from "../src/store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATIENTS_PATH = path.join(__dirname, "..", "data", "patients.json");
const PATIENTS_LOCK_PATH = `${PATIENTS_PATH}.lock`;

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

test("refillStatus stays 'critical', not 'overdue', for a same-day due date at any time of day (the real bug this fixes)", () => {
  // Previously `asOf` (which defaults to the real current moment) was
  // diffed against a midnight-UTC due date without normalizing its own
  // time-of-day, so Math.round() flipped a same-day refill to "overdue"
  // once the clock passed noon UTC.
  const med = { daysSupply: 1, lastFilled: "2026-08-28" };
  const morning = new Date("2026-08-29T01:00:00.000Z");
  const afternoon = new Date("2026-08-29T23:00:00.000Z");
  assert.equal(refillStatus(med, morning).status, "critical");
  assert.equal(refillStatus(med, afternoon).status, "critical");
  assert.equal(refillStatus(med, morning).daysUntilDue, 0);
  assert.equal(refillStatus(med, afternoon).daysUntilDue, 0);
});

test("getRefillAlerts includes refills up to daysAhead even while their status is still 'ok' (the real bug this fixes)", async () => {
  const asOf = new Date("2026-08-29T00:00:00.000Z");
  const patients = [
    {
      id: "p1",
      name: "Test Patient",
      medications: [
        // 10 days out: status is "ok" (bucket only starts at 7 days), but
        // still within a 14-day look-ahead window and must be included.
        { id: "m1", name: "Metformin", daysSupply: 10, lastFilled: "2026-08-29" },
        // 20 days out: outside the window either way, must be excluded.
        { id: "m2", name: "Lisinopril", daysSupply: 20, lastFilled: "2026-08-29" },
      ],
    },
  ];
  const alerts = await getRefillAlerts(14, asOf, { patients });
  assert.deepEqual(
    alerts.map((a) => a.medicationId),
    ["m1"]
  );
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

test("logDose serializes concurrent calls so a race can't silently drop an update (the real bug this fixes)", async () => {
  // Both the REST backend and the MCP server call logDose against the same
  // file; without the lock, an unsynchronized read-modify-write lets one
  // concurrent call's write overwrite another's.
  const original = await readFile(PATIENTS_PATH, "utf-8");
  try {
    const before = (await getPatient("p1")).medications.find((m) => m.id === "p1-m1").adherence.loggedDays;
    const concurrentCalls = 8;
    await Promise.all(
      Array.from({ length: concurrentCalls }, (_, i) => logDose("p1", "p1-m1", i % 2 === 0))
    );
    const after = (await getPatient("p1")).medications.find((m) => m.id === "p1-m1").adherence.loggedDays;
    assert.equal(after, before + concurrentCalls, "every concurrent dose log must be persisted, none lost to a race");
  } finally {
    await writeFile(PATIENTS_PATH, original, "utf-8");
  }
});

test("logDose reclaims a stale lock orphaned by a crashed process instead of blocking forever (the real bug this fixes)", async () => {
  const original = await readFile(PATIENTS_PATH, "utf-8");
  // Simulate a process that acquired the lock and crashed before its
  // `finally` cleanup ran: the lock file exists but is well past the
  // staleness threshold.
  await writeFile(PATIENTS_LOCK_PATH, "", "utf-8");
  const wellPastStale = new Date(Date.now() - 10_000);
  await utimes(PATIENTS_LOCK_PATH, wellPastStale, wellPastStale);
  try {
    const before = (await getPatient("p1")).medications.find((m) => m.id === "p1-m1").adherence.loggedDays;
    const updated = await logDose("p1", "p1-m1", true);
    assert.ok(updated, "logDose must reclaim the stale lock and succeed rather than time out");
    const after = (await getPatient("p1")).medications.find((m) => m.id === "p1-m1").adherence.loggedDays;
    assert.equal(after, before + 1);
  } finally {
    await unlink(PATIENTS_LOCK_PATH).catch(() => {});
    await writeFile(PATIENTS_PATH, original, "utf-8");
  }
});

test("withPatientsLock refreshes the lock's mtime on a heartbeat while held, so a live-but-slow hold is never mistaken for orphaned (the real bug this fixes)", async () => {
  // A purely time-since-acquisition staleness check can't distinguish a
  // crashed owner from one that's simply still working; the fix is for the
  // holder to keep refreshing the lock's mtime, so "stale" means "no
  // heartbeat", not "acquired a while ago". Prove the heartbeat actually
  // fires: hold the lock past one heartbeat tick and confirm the mtime
  // moved forward during the hold, without needing to wait out the full
  // multi-second staleness window this protects against.
  try {
    await withPatientsLock(async () => {
      const acquiredMtime = (await stat(PATIENTS_LOCK_PATH)).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 1400)); // > one heartbeat interval
      const refreshedMtime = (await stat(PATIENTS_LOCK_PATH)).mtimeMs;
      assert.ok(refreshedMtime > acquiredMtime, "the lock's mtime should have been refreshed by a heartbeat while still held");
    });
  } finally {
    await unlink(PATIENTS_LOCK_PATH).catch(() => {});
  }
});
