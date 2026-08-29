import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCaseStore } from "../src/cases.mjs";

const supplyTrigger = {
  type: "supply_risk",
  patientId: "p3",
  patientName: "Priya Ramaswami",
  medicationName: "Sumatriptan",
  priority: "high",
  summary: "FDA shortage: To Be Discontinued",
  evidence: { source: "fda_live", status: "To Be Discontinued" },
};

/** A fresh scratch cases.json per test, so tests never touch the real data file. */
async function withTempCaseStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "pharmaflow-cases-"));
  const casesPath = path.join(dir, "cases.json");
  await writeFile(casesPath, "[]\n", "utf-8");
  try {
    await run(createCaseStore(casesPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("reconcileCases creates a case for a new real trigger", () =>
  withTempCaseStore(async (store) => {
    const cases = await store.reconcileCases([supplyTrigger]);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, "detected");
    assert.equal(cases[0].patientId, "p3");
    assert.match(cases[0].id, /^PF-\d+$/);
  }));

test("reconcileCases refreshes a still-open case's evidence when the real data changes", () =>
  withTempCaseStore(async (store) => {
    await store.reconcileCases([supplyTrigger]);
    const updatedTrigger = { ...supplyTrigger, evidence: { ...supplyTrigger.evidence, status: "Resolved" } };
    const [refreshed] = await store.reconcileCases([updatedTrigger]);
    assert.equal(refreshed.evidence.status, "Resolved", "a still-open case must not display stale evidence");
    assert.equal(refreshed.status, "detected", "refreshing evidence must not itself change the case's status");
  }));

test("reconcileCases never refreshes a case awaiting approval or already resolved, even if the trigger changes", () =>
  withTempCaseStore(async (store) => {
    const [created] = await store.reconcileCases([supplyTrigger]);
    await store.requestApprovalForCase(created.id, { toolCallId: "tc1", threadId: "th1", sessionId: "s1" });
    const updatedTrigger = { ...supplyTrigger, evidence: { ...supplyTrigger.evidence, status: "Resolved" } };
    const [unchanged] = await store.reconcileCases([updatedTrigger]);
    assert.equal(unchanged.evidence.status, "To Be Discontinued", "a pending human decision must be based on stable evidence");
  }));

test("reconcileCases does not duplicate a case for the same recurring trigger", () =>
  withTempCaseStore(async (store) => {
    await store.reconcileCases([supplyTrigger]);
    const cases = await store.reconcileCases([supplyTrigger]);
    assert.equal(cases.length, 1);
  }));

test("reconcileCases auto-resolves a 'detected' case whose trigger cleared", () =>
  withTempCaseStore(async (store) => {
    await store.reconcileCases([supplyTrigger]);
    const cases = await store.reconcileCases([]); // signal cleared
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, "resolved");
    assert.equal(cases[0].pharmacistReview.decision, "auto-resolved");
  }));

test("reconcileCases never auto-resolves a case awaiting approval, even if the trigger clears", () =>
  withTempCaseStore(async (store) => {
    const [created] = await store.reconcileCases([supplyTrigger]);
    await store.requestApprovalForCase(created.id, { toolCallId: "tc1", threadId: "th1", sessionId: "s1" });
    const cases = await store.reconcileCases([]); // signal cleared mid-review
    assert.equal(cases[0].status, "approval_required", "a real pending human decision must not be silently discarded");
  }));

test("requestApprovalForCase rejects an unknown case id (failure case)", () =>
  withTempCaseStore(async (store) => {
    await assert.rejects(
      () => store.requestApprovalForCase("PF-9999", { toolCallId: "t", threadId: "th", sessionId: "s" }),
      /Unknown case/
    );
  }));

test("resolveCaseAfterAction(approved: true) resolves the case with a review record", () =>
  withTempCaseStore(async (store) => {
    const [created] = await store.reconcileCases([supplyTrigger]);
    await store.requestApprovalForCase(created.id, { toolCallId: "tc1", threadId: "th1", sessionId: "s1" });
    const resolved = await store.resolveCaseAfterAction(created.id, { approved: true, note: "Sent to pharmacist." });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.pharmacistReview.decision, "approved");
    assert.equal(resolved.pendingApproval, null);
  }));

test("resolveCaseAfterAction(approved: false) reopens the case rather than closing it", () =>
  withTempCaseStore(async (store) => {
    const [created] = await store.reconcileCases([supplyTrigger]);
    await store.requestApprovalForCase(created.id, { toolCallId: "tc1", threadId: "th1", sessionId: "s1" });
    const denied = await store.resolveCaseAfterAction(created.id, { approved: false, reason: "Not urgent." });
    assert.equal(denied.status, "detected");
    assert.equal(denied.pharmacistReview.decision, "denied");
  }));

test("findCaseByPendingToolCallId finds the right case among several", () =>
  withTempCaseStore(async (store) => {
    const other = { ...supplyTrigger, patientId: "p1", patientName: "Eleanor Whitfield", medicationName: "Warfarin" };
    const cases = await store.reconcileCases([supplyTrigger, other]);
    await store.requestApprovalForCase(cases[1].id, { toolCallId: "tc-target", threadId: "th", sessionId: "s" });
    const found = await store.findCaseByPendingToolCallId("tc-target");
    assert.equal(found.id, cases[1].id);
  }));
