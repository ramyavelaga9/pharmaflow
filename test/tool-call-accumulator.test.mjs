import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolCallAccumulator, resolveActualToolCall } from "../src/tool-call-accumulator.mjs";

test("accumulates a name and arguments streamed across several deltas", () => {
  const acc = createToolCallAccumulator();
  acc.applyDelta({ index: 0, id: "call_1", function: { name: "search_drug", arguments: "" } });
  acc.applyDelta({ index: 0, function: { name: "_shortages", arguments: '{"drugName":' } });
  const call = acc.applyDelta({ index: 0, function: { arguments: '"Warfarin"}' } });
  assert.equal(call.name, "search_drug_shortages");
  assert.equal(call.args, '{"drugName":"Warfarin"}');
  assert.equal(call.id, "call_1");
});

test("a call's id stays stable even when later deltas omit it", () => {
  const acc = createToolCallAccumulator();
  acc.applyDelta({ index: 0, id: "call_1", function: { name: "get_patient" } });
  const second = acc.applyDelta({ index: 0, function: { arguments: '{"patientId":"p1"}' } });
  assert.equal(second.id, "call_1", "the real id must not be replaced by an index fallback on a later delta");
});

test("a second round reusing the same stream index does not concatenate onto a finished call (the real bug this fixes)", () => {
  const acc = createToolCallAccumulator();

  // Round 1: a call at index 0 completes.
  acc.applyDelta({ index: 0, id: "call_round1", function: { name: "list_tools", arguments: "{}" } });
  acc.complete("call_round1");

  // Round 2: a different call reuses index 0.
  const call = acc.applyDelta({ index: 0, id: "call_round2", function: { name: "get_tool_info", arguments: "{}" } });

  assert.equal(call.name, "get_tool_info", "must not be 'list_toolsget_tool_info'");
  assert.equal(call.args, "{}");
});

test("getById finds a call only after its real id has been seen (invalid input case)", () => {
  const acc = createToolCallAccumulator();
  assert.equal(acc.getById("call_never_seen"), undefined);
  acc.applyDelta({ index: 0, id: "call_1", function: { name: "log_dose" } });
  assert.equal(acc.getById("call_1").name, "log_dose");
});

test("complete() on an unknown id is a no-op, not a throw", () => {
  const acc = createToolCallAccumulator();
  assert.doesNotThrow(() => acc.complete("never-existed"));
});

test("resolveActualToolCall passes through a direct call unchanged", () => {
  const resolved = resolveActualToolCall({ name: "create_pharmacist_review", args: '{"caseId":"PF-1001"}' });
  assert.equal(resolved.name, "create_pharmacist_review");
  assert.equal(resolved.args, '{"caseId":"PF-1001"}');
});

test("resolveActualToolCall unwraps TrueForge's call_tool meta-tool (the real bug this fixes)", () => {
  const wrapped = {
    name: "call_tool",
    args: '{"mcp_server":"pharmaflow-tools","tool_name":"create_pharmacist_review","input":{"caseId":"PF-1001","note":"x"}}',
  };
  const resolved = resolveActualToolCall(wrapped);
  assert.equal(resolved.name, "create_pharmacist_review");
  assert.deepEqual(JSON.parse(resolved.args), { caseId: "PF-1001", note: "x" });
});

test("resolveActualToolCall returns null for a wrapped call with no tool_name (invalid input case)", () => {
  const wrapped = { name: "call_tool", args: '{"mcp_server":"pharmaflow-tools"}' };
  assert.equal(resolveActualToolCall(wrapped), null);
});

test("resolveActualToolCall returns null for malformed JSON args instead of throwing", () => {
  assert.doesNotThrow(() => resolveActualToolCall({ name: "call_tool", args: "not json" }));
  assert.equal(resolveActualToolCall({ name: "call_tool", args: "not json" }), null);
});

test("resolveActualToolCall returns null for a null call", () => {
  assert.equal(resolveActualToolCall(null), null);
});
