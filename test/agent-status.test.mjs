import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStatus } from "../src/agent-status.mjs";

test("a fresh agent status has never checked anything", () => {
  const status = createAgentStatus();
  const { lastChecked } = status.getStatus();
  assert.equal(lastChecked.fda, null);
  assert.equal(lastChecked.prescriptions, null);
});

test("recordCheck stamps a real ISO timestamp, never a placeholder", () => {
  const status = createAgentStatus();
  status.recordCheck("fda");
  const { lastChecked } = status.getStatus();
  assert.equal(typeof lastChecked.fda, "string");
  assert.ok(!Number.isNaN(Date.parse(lastChecked.fda)));
  assert.equal(lastChecked.prescriptions, null, "checking one source must not affect another");
});

test("recordCheck rejects an unknown source (invalid input case)", () => {
  const status = createAgentStatus();
  assert.throws(() => status.recordCheck("pharmacy-inventory"), /Unknown check source/);
});

test("getStatus always reports active: true", () => {
  assert.equal(createAgentStatus().getStatus().active, true);
});
