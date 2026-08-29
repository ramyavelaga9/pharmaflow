import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFulfillmentStore } from "../src/fulfillment.mjs";

/** Fresh scratch order/notification files per test, so tests never touch the real data files. */
async function withTempStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "pharmaflow-fulfillment-"));
  const ordersPath = path.join(dir, "orders.json");
  const notificationsPath = path.join(dir, "notifications.json");
  await writeFile(ordersPath, "[]\n", "utf-8");
  await writeFile(notificationsPath, "[]\n", "utf-8");
  try {
    await run(createFulfillmentStore(ordersPath, notificationsPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("placeOrder persists a real order record with a generated id", () =>
  withTempStore(async (store) => {
    const order = await store.placeOrder({
      caseId: "PF-1001",
      patientId: "p2",
      patientName: "Marcus Chen",
      drugName: "Sodium Bicarbonate",
      quantity: 30,
    });
    assert.match(order.id, /^ORD-/);
    assert.equal(order.status, "simulated", "must never claim to be a real transaction");
    const orders = await store.listOrders();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].drugName, "Sodium Bicarbonate");
  }));

test("notifyPatient persists a real, clearly-simulated notification record", () =>
  withTempStore(async (store) => {
    const note = await store.notifyPatient({
      caseId: "PF-1002",
      patientId: "p3",
      patientName: "Priya Ramaswami",
      message: "Your Sumatriptan refill has been switched to Rizatriptan, pending pharmacist approval.",
    });
    assert.match(note.id, /^NOTE-/);
    assert.equal(note.channel, "simulated");
    const notifications = await store.listNotifications();
    assert.equal(notifications.length, 1);
  }));

test("listOrders on an empty store returns an empty array, not a fabricated entry (invalid input case)", () =>
  withTempStore(async (store) => {
    assert.deepEqual(await store.listOrders(), []);
  }));

test("orders and notifications accumulate independently across multiple calls", () =>
  withTempStore(async (store) => {
    await store.placeOrder({ caseId: "PF-1", patientId: "p1", patientName: "A", drugName: "X", quantity: 1 });
    await store.placeOrder({ caseId: "PF-2", patientId: "p2", patientName: "B", drugName: "Y", quantity: 2 });
    await store.notifyPatient({ caseId: "PF-2", patientId: "p2", patientName: "B", message: "hi" });
    assert.equal((await store.listOrders()).length, 2);
    assert.equal((await store.listNotifications()).length, 1);
  }));
