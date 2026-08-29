// PharmaFlow MCP tool server.
//
// Exposes the medication-continuity data layer as MCP tools over Streamable
// HTTP so a TrueForge agent can retrieve patient data and log real actions
// (not just generate text) — this is the "harder problem" piece of the
// hackathon brief. Register it in TrueForge (Settings > Connectors, or via
// `npm run setup`) pointing at http://localhost:8791/mcp.

import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as store from "./store.mjs";
import { createCaseStore } from "./cases.mjs";
import { reconcileCasesFromLiveData } from "./case-reconciliation.mjs";
import * as pharmacyInventory from "./pharmacy-inventory.mjs";
import { createFulfillmentStore } from "./fulfillment.mjs";

const PORT = process.env.MCP_PORT || 8791;
const caseStore = createCaseStore();
const fulfillmentStore = createFulfillmentStore();

function buildServer() {
  const server = new McpServer({ name: "pharmaflow-tools", version: "0.1.0" });

  server.registerTool(
    "list_patients",
    {
      title: "List patients",
      description:
        "List every patient in the panel with a quick-glance summary: name, age, conditions, medication count, and the worst refill status across their medications (ok, due-soon, critical, overdue).",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await store.listPatients(), null, 2) }],
    })
  );

  server.registerTool(
    "get_patient",
    {
      title: "Get patient detail",
      description:
        "Get full detail for one patient: demographics, conditions, every medication with dose/frequency/prescriber, computed refill due-date and urgency, adherence percentage, and any drug-drug interactions among their current medications.",
      inputSchema: { patientId: z.string().describe("Patient id, e.g. 'p1'") },
    },
    async ({ patientId }) => {
      const patient = await store.getPatient(patientId);
      if (!patient) {
        return { content: [{ type: "text", text: `No patient found with id ${patientId}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(patient, null, 2) }] };
    }
  );

  server.registerTool(
    "get_refill_alerts",
    {
      title: "Get refill alerts",
      description:
        "List medications across all patients that are due, critical, or overdue for refill within the given number of days, sorted most urgent first.",
      inputSchema: {
        daysAhead: z.number().int().min(1).max(60).default(7).describe("Look-ahead window in days"),
      },
    },
    async ({ daysAhead }) => ({
      content: [{ type: "text", text: JSON.stringify(await store.getRefillAlerts(daysAhead ?? 7), null, 2) }],
    })
  );

  server.registerTool(
    "check_interactions",
    {
      title: "Check drug interactions",
      description:
        "Check a specific patient's current medication list for known drug-drug interaction risks (severity + clinical note). Omit patientId to check every patient in the panel.",
      inputSchema: { patientId: z.string().optional().describe("Patient id; omit to check everyone") },
    },
    async ({ patientId }) => {
      if (patientId) {
        const patient = await store.getPatient(patientId);
        if (!patient) {
          return { content: [{ type: "text", text: `No patient found with id ${patientId}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(patient.interactions, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await store.getAllInteractionAlerts(), null, 2) }] };
    }
  );

  server.registerTool(
    "log_dose",
    {
      title: "Log a dose taken or missed",
      description:
        "Record that a patient took or missed a dose of one of their medications today. This updates the adherence record used for continuity reporting.",
      inputSchema: {
        patientId: z.string(),
        medicationId: z.string(),
        taken: z.boolean().describe("true if the dose was taken, false if missed"),
      },
    },
    async ({ patientId, medicationId, taken }) => {
      try {
        const updated = await store.logDose(patientId, medicationId, taken);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: String(err.message ?? err) }], isError: true };
      }
    }
  );

  server.registerTool(
    "list_cases",
    {
      title: "List medication continuity cases",
      description:
        "List real medication continuity cases (each tied to an actual detected supply-risk or high-severity interaction), reconciled against live data. Use this to find a case's id before calling create_pharmacist_review - never invent a case id.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await reconcileCasesFromLiveData(caseStore), null, 2) }],
    })
  );

  server.registerTool(
    "check_pharmacy_inventory",
    {
      title: "Check pharmacy inventory",
      description:
        "Check the pharmacy's current stock level for a drug (synthetic data for this prototype - clearly labeled as such). Use this before deciding whether to reorder the same drug or propose an alternative. Pass caseId when checking on behalf of a specific case, so the real number checked is visible on that case, not just in this tool's result.",
      inputSchema: {
        drugName: z.string(),
        caseId: z.string().optional().describe("The case this check is for, if any"),
      },
    },
    async ({ drugName, caseId }) => {
      const stock = await pharmacyInventory.getStock(drugName);
      if (caseId) {
        const kase = await caseStore.getCase(caseId);
        if (kase) {
          await caseStore.recordFulfillment(caseId, { lastCheckedStock: stock, lastCheckedAt: new Date().toISOString() });
        }
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ drugName, stock, source: "synthetic_pharmacy_inventory" }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    "place_refill_order",
    {
      title: "Place a refill order",
      description:
        "Order a fresh supply of a patient's current medication from the pharmacy's own inventory. This is a routine reorder of the same already-prescribed drug (not a clinical decision), so it does NOT require human approval. Fails if stock is 0 - call check_pharmacy_inventory first, and use propose_alternative_supply instead if none is available.",
      inputSchema: { caseId: z.string().describe("The case id, e.g. 'PF-1001'") },
    },
    async ({ caseId }) => {
      try {
        const kase = await caseStore.getCase(caseId);
        if (!kase) return { content: [{ type: "text", text: `No case found with id ${caseId}` }], isError: true };
        if (kase.status !== "detected") {
          return {
            content: [{ type: "text", text: `Case ${caseId} is not awaiting fulfillment (status: ${kase.status}).` }],
            isError: true,
          };
        }
        const stock = await pharmacyInventory.getStock(kase.medicationName);
        if (stock <= 0) {
          return {
            content: [
              { type: "text", text: `${kase.medicationName} has 0 units in pharmacy inventory. Use propose_alternative_supply instead.` },
            ],
            isError: true,
          };
        }
        const patient = await store.getPatient(kase.patientId);
        const med = patient?.medications.find((m) => m.name === kase.medicationName);
        const quantity = med?.daysSupply ? `${med.daysSupply}-day supply` : "1 refill";
        const order = await fulfillmentStore.placeOrder({
          caseId,
          patientId: kase.patientId,
          patientName: kase.patientName,
          drugName: kase.medicationName,
          quantity,
        });
        const resolved = await caseStore.resolveAsFulfilled(caseId, {
          method: "auto_reorder",
          drugName: kase.medicationName,
          quantity,
          orderId: order.id,
          stockAtOrder: stock,
          orderedAt: order.placedAt,
        });
        return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: String(err.message ?? err) }], isError: true };
      }
    }
  );

  server.registerTool(
    "propose_alternative_supply",
    {
      title: "Propose an alternative drug supply",
      description:
        "Propose switching a patient to an alternative drug because the original is out of stock. This is a consequential action and requires human (pharmacist) approval before it runs. alternativeDrugName MUST be one of the vetted candidates for this drug - never invent a substitute; an unlisted name is rejected.",
      inputSchema: {
        caseId: z.string().describe("The case id, e.g. 'PF-1001'"),
        alternativeDrugName: z.string().describe("Must be a name from the reference list for this drug"),
        note: z.string().describe("Short note for the pharmacist explaining the proposed switch"),
      },
    },
    async ({ caseId, alternativeDrugName, note }) => {
      try {
        const kase = await caseStore.getCase(caseId);
        if (!kase) return { content: [{ type: "text", text: `No case found with id ${caseId}` }], isError: true };
        const isVetted = await pharmacyInventory.isApprovedAlternative(kase.medicationName, alternativeDrugName);
        if (!isVetted) {
          return {
            content: [
              {
                type: "text",
                text: `"${alternativeDrugName}" is not a vetted alternative for ${kase.medicationName}. Only a name from the reference list may be proposed.`,
              },
            ],
            isError: true,
          };
        }
        const order = await fulfillmentStore.placeOrder({
          caseId,
          patientId: kase.patientId,
          patientName: kase.patientName,
          drugName: alternativeDrugName,
          quantity: "1 refill",
        });
        const notification = await fulfillmentStore.notifyPatient({
          caseId,
          patientId: kase.patientId,
          patientName: kase.patientName,
          message: `Your prescription for ${kase.medicationName} has been switched to ${alternativeDrugName} due to a supply issue. Contact your pharmacy with any questions.`,
        });
        await caseStore.resolveCaseAfterAction(caseId, { approved: true, note });
        const updated = await caseStore.recordFulfillment(caseId, {
          method: "alternative_supply",
          alternativeDrug: alternativeDrugName,
          orderId: order.id,
          notificationId: notification.id,
          orderedAt: order.placedAt,
          notifiedAt: notification.sentAt,
        });
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: String(err.message ?? err) }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_pharmacist_review",
    {
      title: "Create a pharmacist review",
      description:
        "Hand a medication continuity case off to a pharmacist for review. This is a consequential action and requires human approval before it runs - it does NOT diagnose, prescribe, or change a patient's medication. Only call this for a case that genuinely needs pharmacist attention, never as a default next step.",
      inputSchema: {
        caseId: z.string().describe("The case id, e.g. 'PF-1001'"),
        note: z.string().describe("A short, concrete note for the pharmacist: what was found and why it matters"),
      },
    },
    async ({ caseId, note }) => {
      try {
        const existing = await caseStore.getCase(caseId);
        if (!existing) {
          return { content: [{ type: "text", text: `No case found with id ${caseId}` }], isError: true };
        }
        const updated = await caseStore.resolveCaseAfterAction(caseId, { approved: true, note });
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: String(err.message ?? err) }], isError: true };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Stateless mode (sessionIdGenerator: undefined): each request is handled
// independently with no session/initialize handshake to track, which keeps
// this simple for a prototype and matches TrueForge calling in as a plain
// remote MCP server rather than holding a long-lived connection.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "pharmaflow-mcp-server" }));

app.listen(PORT, () => {
  console.log(`PharmaFlow MCP server listening on http://localhost:${PORT}/mcp`);
});
