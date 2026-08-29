// Medication continuity cases.
//
// A case exists only because a real detection exists (a supply-risk hit
// or a high-severity interaction, computed from store.mjs/fda.mjs data by
// case-triggers.mjs) — nothing here invents a case. Status only advances
// on real events: a case moves to "approval_required" when TrueForge
// actually emits a tool.approval_required event for a create_pharmacist_review
// call tied to it, and to "resolved" only once that tool actually executes
// (or the human explicitly denies it, which reopens the case rather than
// silently closing it).
//
// Persisted to a JSON file on disk — the same pattern as store.mjs — so
// both the backend process and the MCP server process (which is where
// create_pharmacist_review actually runs) see the same case state.
//
// createCaseStore() is a factory rather than a module-level singleton so
// tests can point it at a scratch file instead of the real data file.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES_PATH = path.join(__dirname, "..", "data", "cases.json");

/**
 * Stable identity for "the same real-world issue", so reconciliation never
 * duplicates a case. Accepts either a raw trigger (`type`) or a stored case
 * (`triggerType`) - both must resolve to the same key for the same issue,
 * or a case is never recognized as matching its own trigger again.
 */
function triggerKey(obj) {
  return `${obj.type ?? obj.triggerType}|${obj.patientId}|${obj.medicationName}`;
}

function nextCaseId(existingCases) {
  const numbers = existingCases.map((c) => Number(String(c.id).replace(/^PF-/, ""))).filter(Number.isFinite);
  return `PF-${(numbers.length ? Math.max(...numbers) : 1000) + 1}`;
}

function caseFromTrigger(trigger, id) {
  const now = new Date().toISOString();
  return {
    id,
    patientId: trigger.patientId,
    patientName: trigger.patientName,
    medicationName: trigger.medicationName,
    triggerType: trigger.type,
    triggerSummary: trigger.summary,
    priority: trigger.priority,
    evidence: trigger.evidence,
    status: "detected",
    pendingApproval: null,
    pharmacistReview: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createCaseStore(casesPath = DEFAULT_CASES_PATH) {
  async function loadCases() {
    const raw = await readFile(casesPath, "utf-8");
    return JSON.parse(raw);
  }

  async function saveCases(cases) {
    await writeFile(casesPath, JSON.stringify(cases, null, 2) + "\n", "utf-8");
  }

  /**
   * Ensures a case exists for every real trigger, and auto-resolves a
   * still-"detected" case whose trigger has genuinely cleared (e.g. the
   * FDA shortage record disappeared). A case already in approval_required
   * or already resolved is left alone — a live-data blip must never undo
   * a real human decision or a genuinely completed review.
   */
  async function reconcileCases(triggers) {
    const cases = await loadCases();
    const seenKeys = new Set();

    for (const trigger of triggers) {
      const key = triggerKey(trigger);
      seenKeys.add(key);
      if (!cases.some((c) => triggerKey(c) === key)) {
        cases.push(caseFromTrigger(trigger, nextCaseId(cases)));
      }
    }

    for (const c of cases) {
      if (c.status === "detected" && !seenKeys.has(triggerKey(c))) {
        c.status = "resolved";
        c.pharmacistReview = {
          decision: "auto-resolved",
          note: "Underlying signal cleared before a review was created.",
          resolvedAt: new Date().toISOString(),
        };
        c.updatedAt = c.pharmacistReview.resolvedAt;
      }
    }

    await saveCases(cases);
    return cases;
  }

  async function listCases() {
    return loadCases();
  }

  async function getCase(caseId) {
    const cases = await loadCases();
    return cases.find((c) => c.id === caseId) ?? null;
  }

  async function findCaseByPendingToolCallId(toolCallId) {
    const cases = await loadCases();
    return cases.find((c) => c.pendingApproval?.toolCallId === toolCallId) ?? null;
  }

  // sessionId is stored alongside the pending approval (not just
  // toolCallId/threadId) so an approval can be resumed purely from the
  // durable case record - it survives a page reload, and even a backend
  // restart, without depending on any in-memory conversation state.
  async function requestApprovalForCase(caseId, { toolCallId, threadId, sessionId }) {
    const cases = await loadCases();
    const found = cases.find((c) => c.id === caseId);
    if (!found) throw new Error(`Unknown case: ${caseId}`);
    found.status = "approval_required";
    found.pendingApproval = { toolCallId, threadId, sessionId };
    found.updatedAt = new Date().toISOString();
    await saveCases(cases);
    return found;
  }

  async function resolveCaseAfterAction(caseId, { approved, note, reason }) {
    const cases = await loadCases();
    const found = cases.find((c) => c.id === caseId);
    if (!found) throw new Error(`Unknown case: ${caseId}`);
    found.pendingApproval = null;
    found.updatedAt = new Date().toISOString();
    if (approved) {
      found.status = "resolved";
      found.pharmacistReview = { decision: "approved", note: note ?? "", resolvedAt: found.updatedAt };
    } else {
      // Denied: PharmaFlow's proposed action didn't happen, so the issue
      // is still open — reopen the case rather than silently closing it.
      found.status = "detected";
      found.pharmacistReview = { decision: "denied", note: reason ?? "", resolvedAt: found.updatedAt };
    }
    await saveCases(cases);
    return found;
  }

  return {
    reconcileCases,
    listCases,
    getCase,
    findCaseByPendingToolCallId,
    requestApprovalForCase,
    resolveCaseAfterAction,
  };
}

export { createCaseStore, triggerKey, nextCaseId };
