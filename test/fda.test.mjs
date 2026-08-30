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

test("getRecentShortageUpdates sorts the demo fallback newest-first, not fixture order (the real bug this fixes)", async () => {
  const fetchImpl = async () => {
    throw new Error("network unreachable");
  };
  // The demo fixture lists Warfarin (updated 08/15/2026) before Lisinopril
  // (updated 08/20/2026); a limit=1 slice must return the newer record.
  const results = await getRecentShortageUpdates(1, { fetchImpl });
  assert.equal(results[0].generic_name, "Lisinopril Tablets");
});

test("searchDrugShortages matches a live record by brand name too, not just generic name (the real bug this fixes)", async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return {
      status: 200,
      ok: true,
      json: async () => ({
        results: [
          { generic_name: "Warfarin Sodium", status: "Current", openfda: { generic_name: ["WARFARIN SODIUM"], brand_name: ["COUMADIN"] } },
        ],
      }),
    };
  };
  const results = await searchDrugShortages("Coumadin", { fetchImpl });
  assert.equal(results.length, 1, "expected the live record to match via its brand name Coumadin");
  assert.equal(results[0].source, "fda_live");
  // The endpoint's real searchable brand field is `proprietary_name`, not
  // `brand_name` — assert the query actually uses it (this is the query
  // Qodo's second review caught as targeting the wrong field).
  assert.ok(requestedUrl.includes("proprietary_name"), "query must target the endpoint's real brand field");
});

test("searchDrugShortages matches a live record via proprietary_name, not just openfda.brand_name (the real bug this fixes)", async () => {
  // The query searches `proprietary_name` (the endpoint's real top-level
  // brand field), but a record can carry that field with no harmonized
  // `openfda.brand_name` array at all — the local matcher must still
  // recognize the match rather than discarding a record the query found.
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      results: [
        {
          generic_name: "Warfarin Sodium",
          proprietary_name: "Coumadin",
          status: "Current",
          openfda: { generic_name: ["WARFARIN SODIUM"] },
        },
      ],
    }),
  });
  const results = await searchDrugShortages("Coumadin", { fetchImpl });
  assert.equal(results.length, 1, "expected the record to match via proprietary_name");
});

test("searchDrugShortages falls back to demo data by brand name when the live API is unreachable", async () => {
  const fetchImpl = async () => {
    throw new Error("network unreachable");
  };
  // The demo Warfarin record only lists its brand name as "COUMADIN" — a
  // brand-name search must still find it via openfda.brand_name.
  const results = await searchDrugShortages("Coumadin", { fetchImpl });
  assert.ok(results.length > 0, "expected the Warfarin shortage record via its brand name Coumadin");
  assert.equal(results[0].generic_name, "Warfarin Sodium Tablets");
});

test("searchDrugShortages stays empty on a clean live no-match, never fabricating from demo data (the real bug this fixes)", async () => {
  // A live call that *succeeds* with no active match must stay empty — it
  // must never be "topped up" from the demo fixture, or a clean no-match
  // for a name that happens to collide with a demo record's generic/brand
  // name (e.g. "Coumadin") would fabricate a shortage the live FDA data
  // never reported.
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ results: [] }),
  });
  const results = await searchDrugShortages("Coumadin", { fetchImpl });
  assert.deepEqual(results, []);
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
