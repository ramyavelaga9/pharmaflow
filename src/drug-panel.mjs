// Drug-centric view of the panel: for every medication actually prescribed
// to someone, which real patients take it, and does it have an active FDA
// shortage or recall right now. The complement to the patient-centric
// views elsewhere - same underlying data, organized by drug instead of by
// person, so "what's wrong with this drug, and who does it touch" is one
// answer instead of something you'd have to cross-reference by hand.

import * as store from "./store.mjs";
import * as fda from "./fda.mjs";

/** One row per unique medication name across the whole panel, with the real patients taking it. */
function groupPatientsByMedication(patients) {
  const byMed = new Map();
  for (const p of patients) {
    for (const m of p.medications) {
      if (!byMed.has(m.name)) byMed.set(m.name, []);
      byMed.get(m.name).push({ id: p.id, name: p.name });
    }
  }
  return byMed;
}

function summarizeShortage(records) {
  if (!records.length) return null;
  const r = records[0];
  return { status: r.status, updateDate: r.update_date, source: r.source };
}

function summarizeRecall(records) {
  if (!records.length) return null;
  const r = records[0];
  return {
    classification: r.classification,
    status: r.status,
    recallingFirm: r.recalling_firm,
    reason: r.reason_for_recall,
    distributionPattern: r.distribution_pattern,
    productDescription: r.product_description,
    initiatedDate: r.recall_initiation_date,
    reportDate: r.report_date,
    source: r.source,
  };
}

async function computeDrugPanel() {
  const patients = await store.loadPatients();
  const byMed = groupPatientsByMedication(patients);
  const medNames = [...byMed.keys()];

  const drugs = await Promise.all(
    medNames.map(async (name) => {
      const [shortages, recalls] = await Promise.all([fda.searchDrugShortages(name), fda.searchDrugRecalls(name)]);
      return {
        name,
        patients: byMed.get(name),
        shortage: summarizeShortage(shortages),
        recall: summarizeRecall(recalls),
      };
    })
  );

  // Drugs with a real, active issue lead; alphabetical within each group so
  // the order doesn't jump around between refreshes.
  return drugs.sort((a, b) => {
    const aActive = a.shortage || a.recall ? 0 : 1;
    const bActive = b.shortage || b.recall ? 0 : 1;
    return aActive - bActive || a.name.localeCompare(b.name);
  });
}

export { computeDrugPanel, groupPatientsByMedication, summarizeShortage, summarizeRecall };
