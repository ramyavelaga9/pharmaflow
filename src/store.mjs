// Shared data layer for PharmaFlow.
//
// Both the MCP tool server and the dashboard's REST API read and write the
// same JSON file on disk, so an action the agent takes (e.g. logging a dose)
// is immediately visible on the dashboard, and vice versa. A real deployment
// would swap this for a database — the file is a deliberately simple stand-in
// for a hackathon prototype.

import { readFile, writeFile, rename, open, unlink, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATIENTS_PATH = path.join(__dirname, "..", "data", "patients.json");
const INTERACTIONS_PATH = path.join(__dirname, "..", "data", "interactions.json");
const PATIENTS_LOCK_PATH = `${PATIENTS_PATH}.lock`;
// A real hold (open -> logDose's read/modify/write -> unlink) takes single-digit
// milliseconds. Time-since-acquisition alone can't tell a crashed owner
// apart from one that's simply still working (e.g. a slow disk), so the
// holder refreshes the lock's mtime on a heartbeat (see withPatientsLock)
// well inside this window — "stale" therefore means "no heartbeat in
// STALE_LOCK_MS", not merely "acquired a while ago".
const STALE_LOCK_MS = 5000;
const LOCK_HEARTBEAT_MS = Math.floor(STALE_LOCK_MS / 4);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function today() {
  return new Date();
}

/** Midnight UTC for the same calendar date as `date`, discarding its time-of-day. */
function toUTCDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

async function loadPatients() {
  const raw = await readFile(PATIENTS_PATH, "utf-8");
  return JSON.parse(raw);
}

/** Atomic write (write to a temp file, then rename) so a reader never sees a partially written file. */
async function savePatients(patients) {
  const tmpPath = `${PATIENTS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(patients, null, 2) + "\n", "utf-8");
  await rename(tmpPath, PATIENTS_PATH);
}

/**
 * Simple cross-process exclusive lock via `open(..., "wx")`, so the REST
 * backend and the MCP server (two separate Node processes, both mutating
 * patients.json) can't interleave a read-modify-write and silently drop
 * each other's update.
 */

/** If the lock file's mtime hasn't been refreshed in STALE_LOCK_MS, its owner isn't sending heartbeats — almost certainly a crash, not a live-but-slow hold — so reclaim it. */
async function reclaimStaleLock() {
  try {
    const info = await stat(PATIENTS_LOCK_PATH);
    if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
      await unlink(PATIENTS_LOCK_PATH);
    }
  } catch {
    // Lock disappeared or stat raced with another reclaimer between our
    // EEXIST and here — fine, the next `open` attempt will sort it out.
  }
}

async function withPatientsLock(fn, { retries = 150, delayMs = 50 } = {}) {
  // A token identifying *this* acquisition, not just this process — so a
  // release can tell "the lock I originally acquired" apart from "a lock
  // that currently exists" (which might belong to a different owner that
  // reclaimed and re-acquired after mine went stale).
  const ownerToken = `${process.pid}:${randomUUID()}`;

  let acquired = false;
  for (let attempt = 0; !acquired && attempt < retries; attempt++) {
    try {
      const handle = await open(PATIENTS_LOCK_PATH, "wx");
      await handle.writeFile(ownerToken, "utf-8");
      await handle.close();
      acquired = true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await reclaimStaleLock();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!acquired) throw new Error(`Timed out waiting for lock: ${PATIENTS_LOCK_PATH}`);

  // Refresh the lock's content/mtime while we hold it, well inside
  // STALE_LOCK_MS, so a legitimately slow (but alive) hold is never
  // mistaken by another waiter for an orphaned one — reclaim then means
  // "no heartbeat", not "acquired a while ago".
  const heartbeat = setInterval(() => {
    writeFile(PATIENTS_LOCK_PATH, ownerToken, "utf-8").catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Release only if the lock still identifies us as its owner. If our
    // heartbeat was ever delayed past STALE_LOCK_MS (event-loop
    // congestion, a GC pause), another waiter may have already reclaimed
    // this lock and re-acquired it under its own token — deleting it here
    // would destroy THEIR valid lock and reopen the exact race this
    // mechanism exists to prevent.
    try {
      const currentOwner = await readFile(PATIENTS_LOCK_PATH, "utf-8");
      if (currentOwner === ownerToken) await unlink(PATIENTS_LOCK_PATH);
    } catch {
      // Already gone, or unreadable — nothing more we can safely do.
    }
  }
}

async function loadInteractions() {
  const raw = await readFile(INTERACTIONS_PATH, "utf-8");
  return JSON.parse(raw);
}

/** Refill due date + urgency bucket for one medication. */
function refillStatus(med, asOf = today()) {
  const filled = new Date(med.lastFilled);
  const dueDate = new Date(filled.getTime() + med.daysSupply * MS_PER_DAY);
  // Compare calendar dates, not timestamps: `asOf` defaults to the real
  // current moment (including time-of-day), but `dueDate` is always
  // midnight UTC. Without normalizing `asOf` to midnight too, a medication
  // due "today" silently flips from critical to overdue once the clock
  // passes noon UTC, purely from Math.round()'s fractional-day rounding.
  const daysUntilDue = daysBetween(toUTCDateOnly(asOf), dueDate);
  let status = "ok";
  if (daysUntilDue < 0) status = "overdue";
  else if (daysUntilDue <= 2) status = "critical";
  else if (daysUntilDue <= 7) status = "due-soon";
  return { dueDate: dueDate.toISOString().slice(0, 10), daysUntilDue, status };
}

function isPRN(med) {
  return /\bPRN\b/i.test(med.frequency) || /\bPRN\b/i.test(med.dose);
}

/** Adherence % over the logged window; PRN meds are reported but not flagged. */
function adherenceStats(med) {
  const log = med.adherenceLog ?? [];
  const taken = log.filter(Boolean).length;
  const pct = log.length ? Math.round((taken / log.length) * 100) : null;
  return { takenDays: taken, loggedDays: log.length, adherencePct: pct, prn: isPRN(med) };
}

async function checkInteractionsFor(patient) {
  const table = await loadInteractions();
  const names = patient.medications.map((m) => m.name);
  const hits = [];
  for (const entry of table) {
    if (names.includes(entry.a) && names.includes(entry.b)) {
      hits.push(entry);
    }
  }
  return hits;
}

function enrichPatient(patient, asOf = today()) {
  return {
    ...patient,
    medications: patient.medications.map((m) => ({
      ...m,
      refill: refillStatus(m, asOf),
      adherence: adherenceStats(m),
    })),
  };
}

/** Worst refill urgency across a patient's medications, ranked overdue > critical > due-soon > ok. */
function worstRefillStatus(enrichedMedications) {
  const order = { overdue: 3, critical: 2, "due-soon": 1, ok: 0 };
  return enrichedMedications.reduce(
    (worst, m) => (order[m.refill.status] > order[worst] ? m.refill.status : worst),
    "ok"
  );
}

async function listPatients(asOf = today()) {
  const patients = await loadPatients();
  return patients.map((p) => {
    const enriched = enrichPatient(p, asOf);
    return {
      id: p.id,
      name: p.name,
      age: p.age,
      conditions: p.conditions,
      medicationCount: p.medications.length,
      worstRefillStatus: worstRefillStatus(enriched.medications),
    };
  });
}

/** Pure aggregate over already-summarized patients (from listPatients), for the Mission Control stat tiles. */
function summarizePanel(patientSummaries) {
  const highRiskStatuses = new Set(["critical", "overdue"]);
  return {
    activeCases: patientSummaries.filter((p) => p.worstRefillStatus !== "ok").length,
    highRisk: patientSummaries.filter((p) => highRiskStatuses.has(p.worstRefillStatus)).length,
  };
}

async function getPanelStats(asOf = today()) {
  return summarizePanel(await listPatients(asOf));
}

async function getPatient(patientId, asOf = today()) {
  const patients = await loadPatients();
  const patient = patients.find((p) => p.id === patientId);
  if (!patient) return null;
  const enriched = enrichPatient(patient, asOf);
  const interactions = await checkInteractionsFor(patient);
  return { ...enriched, interactions };
}

async function getRefillAlerts(daysAhead = 7, asOf = today(), { patients: patientsOverride } = {}) {
  const patients = patientsOverride ?? (await loadPatients());
  const alerts = [];
  for (const p of patients) {
    for (const m of p.medications) {
      const r = refillStatus(m, asOf);
      // Select purely on the requested window, not on the display status:
      // `status` only becomes non-"ok" within 7 days, so a 14-day look-ahead
      // was silently dropping everything due 8-14 days out. Overdue items
      // (negative daysUntilDue) are always <= a non-negative daysAhead, so
      // they stay included too.
      if (r.daysUntilDue <= daysAhead) {
        alerts.push({
          patientId: p.id,
          patientName: p.name,
          medicationId: m.id,
          medicationName: m.name,
          ...r,
        });
      }
    }
  }
  alerts.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  return alerts;
}

async function getAllInteractionAlerts() {
  const patients = await loadPatients();
  const out = [];
  for (const p of patients) {
    const hits = await checkInteractionsFor(p);
    for (const h of hits) {
      out.push({ patientId: p.id, patientName: p.name, ...h });
    }
  }
  return out;
}

async function logDose(patientId, medicationId, taken) {
  // logDose is a read-modify-write over the whole patients file, and both
  // the REST backend and the MCP server call it — concurrent calls (even
  // across processes) can race and silently drop one caller's dose log
  // without the lock below.
  return withPatientsLock(async () => {
    const patients = await loadPatients();
    const patient = patients.find((p) => p.id === patientId);
    if (!patient) throw new Error(`Unknown patient: ${patientId}`);
    const med = patient.medications.find((m) => m.id === medicationId);
    if (!med) throw new Error(`Unknown medication: ${medicationId}`);
    med.adherenceLog = med.adherenceLog ?? [];
    med.adherenceLog.push(Boolean(taken));
    await savePatients(patients);
    return { ...med, refill: refillStatus(med), adherence: adherenceStats(med) };
  });
}

export {
  listPatients,
  getPatient,
  getRefillAlerts,
  getAllInteractionAlerts,
  checkInteractionsFor,
  logDose,
  loadPatients,
  refillStatus,
  adherenceStats,
  summarizePanel,
  getPanelStats,
  withPatientsLock, // exported for testing the lock's heartbeat/reclaim behavior directly
};
