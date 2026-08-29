import { test } from "node:test";
import assert from "node:assert/strict";
import { describeToolServer, summarizeToolResult } from "../src/tool-telemetry.mjs";

test("describeToolServer maps known tools to their real MCP server", () => {
  assert.equal(describeToolServer("search_drug_shortages"), "fda-shortages");
  assert.equal(describeToolServer("get_patient"), "pharmaflow-tools");
});

test("describeToolServer reports 'unknown' for an unrecognized tool (invalid input case)", () => {
  assert.equal(describeToolServer("delete_everything"), "unknown");
});

test("summarizeToolResult counts real JSON array results", () => {
  assert.equal(summarizeToolResult("[]"), "0 records returned");
  assert.equal(summarizeToolResult('[{"a":1}]'), "1 record returned");
  assert.equal(summarizeToolResult('[{"a":1},{"a":2}]'), "2 records returned");
});

test("summarizeToolResult handles a single JSON object result", () => {
  assert.equal(summarizeToolResult('{"id":"p1"}'), "1 record returned");
});

test("summarizeToolResult falls back to a truncated preview for plain text", () => {
  assert.equal(summarizeToolResult("Unknown patient: p9"), "Unknown patient: p9");
  const long = "x".repeat(100);
  assert.equal(summarizeToolResult(long), `${"x".repeat(80)}...`);
});

test("summarizeToolResult handles empty content without throwing", () => {
  assert.equal(summarizeToolResult(""), "No result content");
  assert.equal(summarizeToolResult(undefined), "No result content");
});
