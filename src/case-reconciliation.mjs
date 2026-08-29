// Shared by both the dashboard backend and the pharmacy MCP server, so
// "what cases exist right now" is computed identically wherever it's
// asked - from live supply-risk and interaction data - rather than two
// processes drifting toward divergent implementations of the same logic.

import * as store from "./store.mjs";
import * as fda from "./fda.mjs";
import { triggersFromAlerts } from "./case-triggers.mjs";

/**
 * Cross-references every medication on the panel against real (or, if the
 * live API is unreachable, clearly labeled demo) FDA shortage data.
 * Deduped per patient+medication by most recent update, since openFDA
 * reports shortages per package/NDC.
 */
async function computeSupplyRiskAlerts() {
  const patients = await store.loadPatients();
  const uniqueMedNames = [...new Set(patients.flatMap((p) => p.medications.map((m) => m.name)))];
  const shortagesByMed = new Map(
    await Promise.all(uniqueMedNames.map(async (name) => [name, await fda.searchDrugShortages(name)]))
  );

  const alertsByKey = new Map();
  for (const p of patients) {
    for (const m of p.medications) {
      for (const record of shortagesByMed.get(m.name) ?? []) {
        const key = `${p.id}|${m.name}`;
        const existing = alertsByKey.get(key);
        const existingDate = existing && fda.parseShortageDate(existing.updateDate);
        const recordDate = fda.parseShortageDate(record.update_date);
        if (existing && existingDate && recordDate && existingDate >= recordDate) continue;
        alertsByKey.set(key, {
          patientId: p.id,
          patientName: p.name,
          medicationName: m.name,
          status: record.status,
          updateDate: record.update_date,
          source: record.source,
        });
      }
    }
  }
  return [...alertsByKey.values()];
}

/** Reconciles the given case store against fresh live alert data and returns the resulting case list. */
async function reconcileCasesFromLiveData(caseStore) {
  const [supplyRiskAlerts, interactionAlerts] = await Promise.all([
    computeSupplyRiskAlerts(),
    store.getAllInteractionAlerts(),
  ]);
  return caseStore.reconcileCases(triggersFromAlerts(supplyRiskAlerts, interactionAlerts));
}

export { computeSupplyRiskAlerts, reconcileCasesFromLiveData };
