import { test } from "node:test";
import assert from "node:assert/strict";
import { getStock, getAlternatives, isApprovedAlternative } from "../src/pharmacy-inventory.mjs";

test("getStock returns the real synthetic stock count for a known drug", async () => {
  assert.equal(await getStock("Warfarin"), 42);
});

test("getStock returns 0 for a drug not in the table (invalid input case)", async () => {
  assert.equal(await getStock("Not A Real Drug"), 0);
});

test("getAlternatives returns the fixed reference candidates for a drug that has some", async () => {
  const alternatives = await getAlternatives("Sodium Bicarbonate");
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].name, "Potassium Citrate");
});

test("getAlternatives returns an empty list for a drug with no reference candidates", async () => {
  assert.deepEqual(await getAlternatives("Warfarin"), []);
});

test("isApprovedAlternative is true only for a name that's actually in the reference table", async () => {
  assert.equal(await isApprovedAlternative("Sodium Bicarbonate", "Potassium Citrate"), true);
});

test("isApprovedAlternative rejects an invented name not in the reference table (the real guardrail)", async () => {
  assert.equal(await isApprovedAlternative("Sodium Bicarbonate", "Something The Model Made Up"), false);
});
