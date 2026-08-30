// Patient recall alerts & pharmacist acknowledgment manager.
//
// Cross-references patient prescriptions against FDA drug recalls.
// When an active recall touches a patient, prescription renewals are
// blocked, and a pharmacist action item is presented to send a patient
// recall alert email/notification. Once acknowledged/sent, the alert is
// resolved.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.mjs";
import * as fda from "./fda.mjs";
import { createFulfillmentStore } from "./fulfillment.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECALLS_STORE_PATH = path.join(__dirname, "..", "data", "recalls.json");
const fulfillmentStore = createFulfillmentStore();

function createRecallStore(storePath = RECALLS_STORE_PATH) {
  async function loadAcknowledged() {
    try {
      const raw = await readFile(storePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async function saveAcknowledged(list) {
    await writeFile(storePath, JSON.stringify(list, null, 2) + "\n", "utf-8");
  }

  /**
   * Computes active FDA recall alerts for all patients on the panel.
   * Filters out already acknowledged alerts so approved alerts leave the list.
   */
  async function getActiveRecallAlerts() {
    const patients = await store.loadPatients();
    const acknowledged = new Set(await loadAcknowledged());
    const uniqueMeds = [...new Set(patients.flatMap((p) => p.medications.map((m) => m.name)))];

    const recallsByMed = new Map(
      await Promise.all(uniqueMeds.map(async (name) => [name, await fda.searchDrugRecalls(name)]))
    );

    const alerts = [];
    for (const p of patients) {
      for (const m of p.medications) {
        const hits = recallsByMed.get(m.name) ?? [];
        for (const r of hits) {
          const id = `RECALL-${p.id}-${m.name.replace(/\s+/g, "")}`;
          if (acknowledged.has(id)) continue;
          alerts.push({
            id,
            patientId: p.id,
            patientName: p.name,
            medicationName: m.name,
            classification: r.classification ?? "Class II",
            recallingFirm: r.recalling_firm ?? "Pharmaceutical Manufacturer",
            reason: r.reason_for_recall ?? "FDA Enforcement Action",
            distributionPattern: r.distribution_pattern ?? "Nationwide",
            productDescription: r.product_description ?? m.name,
            initiatedDate: r.recall_initiation_date ?? "",
            renewalBlocked: true,
            status: "unacknowledged",
          });
        }
      }
    }
    return alerts;
  }

  async function acknowledgeRecallAlert(recallId, { patientId, patientName, medicationName, note }) {
    const acknowledged = await loadAcknowledged();
    if (!acknowledged.includes(recallId)) {
      acknowledged.push(recallId);
      await saveAcknowledged(acknowledged);
    }

    const message =
      `CRITICAL FDA RECALL ALERT: Your prescribed medication "${medicationName}" is under an active FDA recall. ` +
      `Prescription renewal has been blocked for safety. Please contact your pharmacist immediately.`;

    const notification = await fulfillmentStore.notifyPatient({
      caseId: recallId,
      patientId,
      patientName,
      message,
    });

    return {
      id: recallId,
      status: "acknowledged",
      acknowledgedAt: new Date().toISOString(),
      notificationId: notification.id,
      messageSent: message,
    };
  }

  return { getActiveRecallAlerts, acknowledgeRecallAlert };
}

export { createRecallStore };
