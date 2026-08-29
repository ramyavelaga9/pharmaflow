// Real, persisted records of what PharmaFlow's fulfillment tools actually
// did - an order, a patient notification - kept separate from the case
// store because they're append-only logs, not mutable case state. Both
// "placing an order" and "notifying a patient" are simulated here (no
// real pharmacy-ordering or messaging integration exists), and every
// record says so explicitly rather than looking like a real transaction.
//
// createFulfillmentStore() is a factory (not a module-level singleton),
// the same pattern as cases.mjs and event-log.mjs, so tests can point it
// at scratch files instead of the real data files.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ORDERS_PATH = path.join(__dirname, "..", "data", "orders.json");
const DEFAULT_NOTIFICATIONS_PATH = path.join(__dirname, "..", "data", "notifications.json");

function createFulfillmentStore(ordersPath = DEFAULT_ORDERS_PATH, notificationsPath = DEFAULT_NOTIFICATIONS_PATH) {
  async function readJson(filePath) {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  }

  async function appendJson(filePath, record) {
    const records = await readJson(filePath);
    records.push(record);
    await writeFile(filePath, JSON.stringify(records, null, 2) + "\n", "utf-8");
    return record;
  }

  async function placeOrder({ caseId, patientId, patientName, drugName, quantity }) {
    return appendJson(ordersPath, {
      id: `ORD-${randomUUID().slice(0, 8)}`,
      caseId,
      patientId,
      patientName,
      drugName,
      quantity,
      status: "simulated",
      placedAt: new Date().toISOString(),
    });
  }

  async function notifyPatient({ caseId, patientId, patientName, message }) {
    return appendJson(notificationsPath, {
      id: `NOTE-${randomUUID().slice(0, 8)}`,
      caseId,
      patientId,
      patientName,
      message,
      channel: "simulated",
      sentAt: new Date().toISOString(),
    });
  }

  async function listOrders() {
    return readJson(ordersPath);
  }

  async function listNotifications() {
    return readJson(notificationsPath);
  }

  return { placeOrder, notifyPatient, listOrders, listNotifications };
}

export { createFulfillmentStore };
