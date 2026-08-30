import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDrugName,
  namesMatch,
  isActiveShortage,
  isActiveRecall,
  parseShortageDate,
  searchDrugShortages,
  getRecentShortageUpdates,
  searchDrugRecalls,
} from "../src/fda.mjs";

test("normalizeDrugName strips case and common salt-form suffixes", () => {
  assert.equal(normalizeDrugName("WARFARIN SODIUM"), "warfarin");
  assert.equal(normalizeDrugName("Lisinopril"), "lisinopril");
  assert.equal(normalizeDrugName("  Metformin Hydrochloride  "), "metformin");
});

test("namesMatch is case/salt-form insensitive", () => {
  assert.equal(namesMatch("Warfarin", "WARFARIN SODIUM"), true);
  assert.equal(namesMatch("warfarin sodium", "Warfarin"), true);
});

test("namesMatch avoids false-positive substring matches (invalid input case)", () => {
  // "aspirin" must not match a generic name that merely contains it as a
  // substring of an unrelated compound name.
  assert.equal(namesMatch("aspirin", "aspirin-like compound"), false);
  assert.equal(namesMatch("", "warfarin"), false);
  assert.equal(namesMatch("warfarin", ""), false);
});

test("isActiveShortage filters out resolved and discontinued records", () => {
  assert.equal(isActiveShortage({ status: "Current" }), true);
  assert.equal(isActiveShortage({ status: "To Be Discontinued" }), true);
  assert.equal(isActiveShortage({ status: "Resolved" }), false);
  assert.equal(isActiveShortage({ status: "Discontinued" }), false);
  assert.equal(isActiveShortage({}), true);
});

test("searchDrugShortages treats openFDA's 404 'no matches' as an empty result, not a failure", async () => {
  const fetchImpl = async () => ({ status: 404, ok: false });
  const results = await searchDrugShortages("nonexistent-drug", { fetchImpl });
  assert.deepEqual(results, []);
});

test("searchDrugShortages falls back to labeled demo data when the live API is unreachable", async () => {
  const fetchImpl = async () => {
    throw new Error("network unreachable");
  };
  const results = await searchDrugShortages("Warfarin", { fetchImpl });
  assert.ok(results.length > 0, "expected at least one demo record for Warfarin");
  for (const r of results) assert.equal(r.source, "demo");
});

test("searchDrugShortages returns live-labeled, name-matched, active records", async () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      results: [
        { generic_name: "Warfarin Sodium", status: "Current", openfda: { generic_name: ["WARFARIN SODIUM"] } },
        { generic_name: "Ibuprofen", status: "Resolved", openfda: { generic_name: ["IBUPROFEN"] } },
      ],
    }),
  });
  const results = await searchDrugShortages("Warfarin", { fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0].source, "fda_live");
  assert.equal(results[0].status, "Current");
});

test("parseShortageDate orders MM/DD/YYYY strings by actual chronology, not lexicographically", () => {
  // A naive string compare would rank "09/08/2025" above "08/24/2026" —
  // this is the exact bug the dedup logic in backend.mjs must avoid.
  const earlier = parseShortageDate("09/08/2025");
  const later = parseShortageDate("08/24/2026");
  assert.ok(earlier < later, "2025 record should sort before the 2026 record");
});

test("parseShortageDate returns null for an unparseable value (invalid input case)", () => {
  assert.equal(parseShortageDate("not-a-date"), null);
  assert.equal(parseShortageDate(undefined), null);
});

test("getRecentShortageUpdates falls back to demo data and respects the limit", async () => {
  const fetchImpl = async () => {
    throw new Error("network unreachable");
  };
  const results = await getRecentShortageUpdates(1, { fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0].source, "demo");
});

test("isActiveRecall is true only while a recall is Ongoing, not once Terminated", () => {
  assert.equal(isActiveRecall({ status: "Ongoing" }), true);
  assert.equal(isActiveRecall({ status: "Terminated" }), false);
  assert.equal(isActiveRecall({}), false, "an unknown status must not default to active");
});

test("searchDrugRecalls filters out a combination product that merely contains the drug name (invalid input case)", () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      results: [
        {
          status: "Ongoing",
          classification: "Class II",
          openfda: { generic_name: ["DAPAGLIFLOZIN AND METFORMIN HYDROCHLORIDE"] },
        },
        { status: "Ongoing", classification: "Class III", openfda: { generic_name: ["METFORMIN HYDROCHLORIDE"] } },
      ],
    }),
  });
  return searchDrugRecalls("Metformin", { fetchImpl }).then((results) => {
    assert.equal(results.length, 1, "the combination product must not be reported as a Metformin recall");
    assert.equal(results[0].classification, "Class III");
  });
});

test("searchDrugRecalls falls back to labeled demo data when the live API is unreachable", async () => {
  const fetchImpl = async () => {
    throw new Error("network unreachable");
  };
  const results = await searchDrugRecalls("Metformin", { fetchImpl });
  assert.ok(results.length > 0, "expected at least one demo recall for Metformin");
  for (const r of results) assert.equal(r.source, "demo");
});

test("searchDrugRecalls excludes a Terminated recall even when the live API returns it", async () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      results: [{ status: "Terminated", classification: "Class II", openfda: { generic_name: ["NAPROXEN SODIUM"] } }],
    }),
  });
  const results = await searchDrugRecalls("Naproxen", { fetchImpl });
  assert.deepEqual(results, []);
});
