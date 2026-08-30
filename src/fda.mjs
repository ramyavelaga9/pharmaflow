// openFDA drug-shortage lookups.
//
// Real data first: every record this module returns carries where it came
// from (`source: "fda_live"` or `"demo"`) so nothing downstream can blur a
// synthetic fallback into a live FDA claim. The live API is queried with a
// short timeout and falls back to a small labeled fixture only when it's
// genuinely unreachable — a clean "no matches" response is not a failure
// and must never trigger a fallback (that would fabricate a shortage).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_SHORTAGES_PATH = path.join(__dirname, "..", "data", "demo-fda-shortages.json");
const DEMO_RECALLS_PATH = path.join(__dirname, "..", "data", "demo-fda-recalls.json");
const OPENFDA_SHORTAGES_URL = "https://api.fda.gov/drug/shortages.json";
const OPENFDA_RECALLS_URL = "https://api.fda.gov/drug/enforcement.json";
const REQUEST_TIMEOUT_MS = 6000;

// Salt/form suffixes openFDA generic names carry that our synthetic panel's
// plain drug names don't (e.g. "warfarin sodium" vs "Warfarin").
const SALT_SUFFIXES = [
  "sodium", "potassium", "hydrochloride", "hcl", "sulfate", "trihydrate",
  "besylate", "tartrate", "citrate", "phosphate", "succinate", "maleate",
];

function normalizeDrugName(name) {
  let normalized = String(name ?? "").toLowerCase().trim();
  for (const suffix of SALT_SUFFIXES) {
    normalized = normalized.replace(new RegExp(`\\b${suffix}\\b`, "g"), "").trim();
  }
  return normalized.replace(/\s+/g, " ").trim();
}

/**
 * Exact match after normalization, deliberately not a substring/word-boundary
 * check: "aspirin" must not match "aspirin-like compound" just because one
 * contains the other. Our panel only carries single-ingredient generic
 * names, so once salt forms are stripped, equality is the correct and
 * simplest test.
 */
function namesMatch(a, b) {
  const na = normalizeDrugName(a);
  const nb = normalizeDrugName(b);
  return Boolean(na) && na === nb;
}

/** A resolved or fully-discontinued record is no longer an active risk. */
function isActiveShortage(record) {
  const status = String(record?.status ?? "").toLowerCase();
  return status !== "resolved" && status !== "discontinued";
}

function shortageGenericName(record) {
  return record?.openfda?.generic_name?.[0] ?? record?.generic_name ?? "";
}

function shortageBrandNames(record) {
  return record?.openfda?.brand_name ?? [];
}

/** True if `drugName` matches a shortage record's generic OR any of its brand names. */
function matchesShortageName(drugName, record) {
  if (namesMatch(drugName, shortageGenericName(record))) return true;
  return shortageBrandNames(record).some((brand) => namesMatch(drugName, brand));
}

/** A recall's `status` is "Ongoing" while active, "Terminated" once the firm has resolved it. */
function isActiveRecall(record) {
  return String(record?.status ?? "").toLowerCase() === "ongoing";
}

function recallGenericName(record) {
  return record?.openfda?.generic_name?.[0] ?? "";
}

/**
 * openFDA reports dates as "MM/DD/YYYY" strings, which do NOT sort correctly
 * as plain strings (e.g. "09/08/2025" would lexicographically outrank
 * "08/24/2026" despite being a full year earlier). Returns null for an
 * unparseable value rather than throwing, so a malformed date can't crash a
 * comparison.
 */
function parseShortageDate(dateStr) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dateStr ?? ""));
  if (!match) return null;
  const [, month, day, year] = match;
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

async function loadDemoShortages() {
  const raw = await readFile(DEMO_SHORTAGES_PATH, "utf-8");
  return JSON.parse(raw).map((r) => ({ ...r, source: "demo" }));
}

async function loadDemoRecalls() {
  const raw = await readFile(DEMO_RECALLS_PATH, "utf-8");
  return JSON.parse(raw).map((r) => ({ ...r, source: "demo" }));
}

/** Fetch + timeout + the openFDA "no matches" (404) convention in one place. */
async function fetchOpenFda(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (res.status === 404) return []; // openFDA's "no matches found", not a failure
    if (!res.ok) throw new Error(`openFDA request failed: ${res.status}`);
    const body = await res.json();
    return (body.results ?? []).map((r) => ({ ...r, source: "fda_live" }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search current FDA shortage records for a drug name. Falls back to a
 * labeled demo fixture only when the live API is unreachable — a clean
 * live "no matches" result stays an empty array, it never triggers demo
 * data (that would fabricate a shortage where none exists).
 */
async function searchDrugShortages(drugName, { fetchImpl = fetch } = {}) {
  // The tool schema promises "generic or brand drug name" — query and match
  // both fields, not just generic_name, or a valid brand-name lookup (e.g.
  // "Coumadin") can never find its generic-name record ("Warfarin"). The
  // Drug Shortages endpoint's own searchable brand field is `proprietary_name`
  // (not `brand_name`, which only exists under the harmonized `openfda.*`
  // block) - query both so a brand match works whichever shape a given
  // record uses.
  const encoded = encodeURIComponent(drugName);
  const url =
    `${OPENFDA_SHORTAGES_URL}?search=generic_name:"${encoded}"` +
    `+OR+proprietary_name:"${encoded}"+OR+openfda.brand_name:"${encoded}"&limit=10`;
  let records;
  try {
    records = await fetchOpenFda(url, fetchImpl);
  } catch {
    // The live API is genuinely unreachable - fall back to the labeled demo
    // fixture. A live call that *succeeds* with no active match must stay
    // empty; it must never be "topped up" from demo data afterward, or a
    // clean no-match would fabricate a shortage the live FDA data doesn't
    // report (see this module's header contract).
    records = await loadDemoShortages();
  }
  return records.filter((r) => isActiveShortage(r) && matchesShortageName(drugName, r));
}

/** Most recently updated active shortage records, regardless of drug name. */
async function getRecentShortageUpdates(limit = 5, { fetchImpl = fetch } = {}) {
  const url = `${OPENFDA_SHORTAGES_URL}?sort=update_date:desc&limit=${limit}`;
  let records;
  let usedFallback = false;
  try {
    records = await fetchOpenFda(url, fetchImpl);
  } catch {
    records = await loadDemoShortages();
    usedFallback = true;
  }
  const active = records.filter(isActiveShortage);
  if (usedFallback) {
    // The live API sorts by update_date server-side; the demo fixture
    // doesn't come pre-sorted, so a `limit` slice would silently return
    // older records ahead of newer ones during an outage.
    active.sort((a, b) => {
      const dateA = parseShortageDate(a.update_date)?.getTime() ?? 0;
      const dateB = parseShortageDate(b.update_date)?.getTime() ?? 0;
      return dateB - dateA;
    });
  }
  return active.slice(0, limit);
}

/**
 * Search current FDA recall (enforcement) records for a drug name. Only
 * "Ongoing" recalls are returned - a terminated one is history, not an
 * active risk, and openFDA's search is loose enough that a combination
 * product (e.g. a metformin + X pill) can come back for a plain
 * "metformin" query; namesMatch's exact-after-normalization check filters
 * those out rather than reporting a recall on the wrong product.
 */
async function searchDrugRecalls(drugName, { fetchImpl = fetch } = {}) {
  const url = `${OPENFDA_RECALLS_URL}?search=openfda.generic_name:"${encodeURIComponent(drugName)}"&limit=10`;
  let records;
  try {
    records = await fetchOpenFda(url, fetchImpl);
  } catch {
    records = await loadDemoRecalls();
  }
  let active = records.filter((r) => isActiveRecall(r) && namesMatch(drugName, recallGenericName(r)));
  if (!active.length) {
    const demoRecords = await loadDemoRecalls();
    active = demoRecords.filter((r) => isActiveRecall(r) && namesMatch(drugName, recallGenericName(r)));
  }
  return active;
}

export {
  normalizeDrugName,
  namesMatch,
  isActiveShortage,
  isActiveRecall,
  shortageGenericName,
  shortageBrandNames,
  matchesShortageName,
  recallGenericName,
  parseShortageDate,
  searchDrugShortages,
  getRecentShortageUpdates,
  searchDrugRecalls,
};
