// Synthetic pharmacy inventory and drug-alternative reference data.
//
// There is no real, public pharmacy-inventory API - inventory is
// proprietary to each pharmacy system. Rather than silently pretend this
// doesn't matter (the earlier Drug Panel work labeled it "Not tracked in
// this prototype"), this module makes it real *within the prototype's own
// data*: a small, clearly-labeled synthetic stock table, and a small,
// clearly-labeled static list of alternative-drug candidates. The
// alternatives list is deliberately not something an LLM invents - it's a
// fixed reference a pharmacist would still need to sign off on, which is
// the whole reason `propose_alternative_supply` stays approval-gated.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY_PATH = path.join(__dirname, "..", "data", "pharmacy-inventory.json");
const ALTERNATIVES_PATH = path.join(__dirname, "..", "data", "drug-alternatives.json");

async function getStock(drugName) {
  const raw = await readFile(INVENTORY_PATH, "utf-8");
  const { stock } = JSON.parse(raw);
  return stock[drugName] ?? 0;
}

/** Only ever returns candidates from the fixed reference table - never an invented name. */
async function getAlternatives(drugName) {
  const raw = await readFile(ALTERNATIVES_PATH, "utf-8");
  const { alternatives } = JSON.parse(raw);
  return alternatives[drugName] ?? [];
}

/** True only if `candidateName` is actually one of the vetted alternatives for `drugName`. */
async function isApprovedAlternative(drugName, candidateName) {
  const candidates = await getAlternatives(drugName);
  return candidates.some((c) => c.name === candidateName);
}

export { getStock, getAlternatives, isApprovedAlternative };
