import { test } from "node:test";
import assert from "node:assert/strict";
import { groupPatientsByMedication, summarizeShortage, summarizeRecall } from "../src/drug-panel.mjs";

const patients = [
  { id: "p1", name: "Eleanor Whitfield", medications: [{ name: "Warfarin" }, { name: "Lisinopril" }] },
  { id: "p2", name: "Marcus Chen", medications: [{ name: "Lisinopril" }] },
];

test("groupPatientsByMedication lists every real patient taking each drug", () => {
  const byMed = groupPatientsByMedication(patients);
  assert.deepEqual(byMed.get("Warfarin"), [{ id: "p1", name: "Eleanor Whitfield" }]);
  assert.deepEqual(byMed.get("Lisinopril"), [
    { id: "p1", name: "Eleanor Whitfield" },
    { id: "p2", name: "Marcus Chen" },
  ]);
});

test("groupPatientsByMedication has no entry for a drug nobody takes (not a fabricated empty row)", () => {
  const byMed = groupPatientsByMedication(patients);
  assert.equal(byMed.has("Metformin"), false);
});

test("summarizeShortage returns null when there is no active shortage (invalid input case)", () => {
  assert.equal(summarizeShortage([]), null);
});

test("summarizeShortage surfaces the real status/source, not a fabricated one", () => {
  const summary = summarizeShortage([{ status: "Current", update_date: "08/25/2026", source: "fda_live" }]);
  assert.deepEqual(summary, { status: "Current", updateDate: "08/25/2026", source: "fda_live" });
});

test("summarizeRecall returns null when there is no active recall", () => {
  assert.equal(summarizeRecall([]), null);
});

test("summarizeRecall surfaces the real classification and reason", () => {
  const summary = summarizeRecall([
    {
      classification: "Class II",
      status: "Ongoing",
      recalling_firm: "Acme Labs",
      reason_for_recall: "CGMP deviations.",
      distribution_pattern: "Nationwide",
      product_description: "Naproxen Sodium Tablets",
      recall_initiation_date: "20250313",
      report_date: "20250416",
      source: "fda_live",
    },
  ]);
  assert.equal(summary.classification, "Class II");
  assert.equal(summary.recallingFirm, "Acme Labs");
  assert.equal(summary.reason, "CGMP deviations.");
});
