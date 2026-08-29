import { test } from "node:test";
import assert from "node:assert/strict";
import { triggersFromAlerts } from "../src/case-triggers.mjs";

const supplyAlert = {
  patientId: "p3",
  patientName: "Priya Ramaswami",
  medicationName: "Sumatriptan",
  status: "To Be Discontinued",
  updateDate: "09/08/2025",
  source: "fda_live",
};

const highInteraction = {
  patientId: "p1",
  patientName: "Eleanor Whitfield",
  a: "Warfarin",
  b: "Ibuprofen",
  severity: "high",
  note: "Increased bleeding risk.",
};

const moderateInteraction = { ...highInteraction, severity: "moderate" };

test("every supply-risk alert becomes a case trigger", () => {
  const triggers = triggersFromAlerts([supplyAlert], []);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].type, "supply_risk");
  assert.equal(triggers[0].patientId, "p3");
  assert.equal(triggers[0].priority, "high");
});

test("only high-severity interactions become case triggers", () => {
  const triggers = triggersFromAlerts([], [highInteraction, moderateInteraction]);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].type, "interaction_risk");
});

test("no alerts produces no triggers (not a fabricated placeholder case)", () => {
  assert.deepEqual(triggersFromAlerts([], []), []);
});

test("each trigger carries its real evidence, not a summary that loses the source", () => {
  const [trigger] = triggersFromAlerts([supplyAlert], []);
  assert.equal(trigger.evidence.source, "fda_live");
  assert.equal(trigger.evidence.status, "To Be Discontinued");
});
