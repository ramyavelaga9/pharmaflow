// PharmaFlow web backend.
//
// Serves the dashboard UI and a small REST API that reads/writes the shared
// patient data directly (fast, no LLM round-trip needed for the dashboard
// itself), plus /api/chat and /api/chat/approval which drive the
// "pharmaflow" TrueForge agent and relay its streamed turns as
// Server-Sent Events to the browser.

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import * as store from "./store.mjs";
import { createEventLog, DEFAULT_MAX_EVENTS } from "./event-log.mjs";
import { createAgentStatus } from "./agent-status.mjs";
import { createCaseStore } from "./cases.mjs";
import { computeSupplyRiskAlerts, reconcileCasesFromLiveData } from "./case-reconciliation.mjs";
import { describeToolServer, summarizeToolResult } from "./tool-telemetry.mjs";
import { createToolCallAccumulator, resolveActualToolCall } from "./tool-call-accumulator.mjs";
import { computeDrugPanel } from "./drug-panel.mjs";
import { createRecallStore } from "./recalls.mjs";
import { createFulfillmentStore } from "./fulfillment.mjs";

// Tools that require a pharmacist's explicit approval before they run, and
// tools whose result should refresh the case-status line in the live event
// feed - kept as simple name lists here rather than duplicated inline
// checks, since both the chat flow and the autonomous fulfillment flow
// share this same event-processing code.
const APPROVAL_GATED_TOOLS = new Set(["create_pharmacist_review", "propose_alternative_supply"]);
const CASE_MUTATING_TOOLS = new Set(["create_pharmacist_review", "place_refill_order", "propose_alternative_supply"]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const TRUEFORGE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const AGENT_NAME = process.env.PHARMAFLOW_AGENT_NAME || "pharmaflow";

const trueforge = new TrueForge({ baseUrl: TRUEFORGE_URL, timeoutInSeconds: 120 });

// conversationId (browser-generated, persisted client-side) -> TrueForge
// session id, so a chat keeps context across turns without the browser
// needing to know anything about TrueForge's session model.
const conversationSessions = new Map();

// Real agent activity (session start, tool calls, tool results, turn
// completion), for the Mission Control tab's live event feed.
const missionControlLog = createEventLog();
const agentStatus = createAgentStatus();
const caseStore = createCaseStore();
const recallStore = createRecallStore();
const fulfillmentStore = createFulfillmentStore();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

app.get("/api/recalls", async (_req, res) => {
  try {
    const alerts = await recallStore.getActiveRecallAlerts();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/recalls/:id/acknowledge", async (req, res) => {
  try {
    const { patientId, patientName, medicationName, note } = req.body ?? {};
    const result = await recallStore.acknowledgeRecallAlert(req.params.id, {
      patientId,
      patientName,
      medicationName,
      note,
    });
    missionControlLog.addEvent({
      type: "case_update",
      label: `Recall Alert Sent & Acknowledged: ${medicationName} · ${patientName} (Dummy Email Sent)`,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Dashboard REST API (no LLM involved — instant, always available) ----

app.get("/api/patients", async (_req, res) => {
  agentStatus.recordCheck("prescriptions");
  res.json(await store.listPatients());
});

app.get("/api/patients/:id", async (req, res) => {
  const patient = await store.getPatient(req.params.id);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  res.json(patient);
});

app.get("/api/refill-alerts", async (req, res) => {
  const daysAhead = Number(req.query.days) || 7;
  agentStatus.recordCheck("prescriptions");
  res.json(await store.getRefillAlerts(daysAhead));
});

app.get("/api/interaction-alerts", async (_req, res) => {
  res.json(await store.getAllInteractionAlerts());
});

app.post("/api/patients/:id/medications/:medId/log", async (req, res) => {
  try {
    const updated = await store.logDose(req.params.id, req.params.medId, Boolean(req.body?.taken));
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/supply-risk", async (_req, res) => {
  try {
    const alerts = await computeSupplyRiskAlerts();
    agentStatus.recordCheck("fda");
    res.json(alerts);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Drug-centric view: every medication actually prescribed on the panel,
// which real patients take it, and its current FDA shortage/recall status.
app.get("/api/drugs", async (_req, res) => {
  try {
    const drugs = await computeDrugPanel();
    agentStatus.recordCheck("fda");
    res.json(drugs);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Cases: real detections only, real lifecycle transitions only ----

// Every supply-risk case is auto-triggered for fulfillment at most once
// per server run - marked synchronously (before any await) the moment a
// request handler decides to trigger one, so two near-simultaneous
// pollers can never both fire it.
const fulfillmentTriggered = new Set();

/**
 * Starts the agent on its own - no chat message, no person asking - to
 * check real inventory and either reorder or propose a vetted alternative
 * for a newly detected supply-risk case. Fire-and-forget: the caller must
 * not await this, since a turn can take well over a minute and nothing
 * should block the dashboard's polling on it.
 */
async function triggerAutonomousFulfillment(kase) {
  try {
    await caseStore.recordFulfillment(kase.id, { status: "investigating", startedAt: new Date().toISOString() });
    missionControlLog.addEvent({
      type: "session",
      label: `Case ${kase.id} detected (${kase.medicationName} · ${kase.patientName}) - PharmaFlow investigating automatically`,
    });
    const { data: session } = await trueforge.sessions.create({ agent: { name: AGENT_NAME } });
    const instruction =
      `A new medication continuity case was just detected: ${kase.id} - ${kase.medicationName} ` +
      `for ${kase.patientName} (${kase.triggerSummary}). Handle fulfillment for this case now.`;
    await runBackgroundTurn(session.id, [{ type: "user.message", content: instruction }]);
  } catch (err) {
    console.error(`Autonomous fulfillment failed for case ${kase.id}:`, err);
    missionControlLog.addEvent({ type: "turn_done", label: `Autonomous fulfillment failed for case ${kase.id}` });
  }
}

app.get("/api/cases", async (_req, res) => {
  try {
    const cases = await reconcileCasesFromLiveData(caseStore);
    agentStatus.recordCheck("fda");
    for (const kase of cases) {
      if (kase.triggerType === "supply_risk" && kase.status === "detected" && !fulfillmentTriggered.has(kase.id)) {
        fulfillmentTriggered.add(kase.id);
        triggerAutonomousFulfillment(kase);
      }
    }
    res.json(cases);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/cases/:id", async (req, res) => {
  const kase = await caseStore.getCase(req.params.id);
  if (!kase) return res.status(404).json({ error: "Case not found" });
  res.json(kase);
});

// ---- Mission Control: real agent activity, not a mock of a bigger system ----

app.get("/api/agent-status", async (_req, res) => {
  const cases = await caseStore.listCases();
  const casesRequiringAttention = cases.filter((c) => c.status !== "resolved").length;
  res.json({ ...agentStatus.getStatus(), casesRequiringAttention });
});

app.get("/api/events", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(missionControlLog.getRecentEvents(limit));
});

app.get("/api/mission-control/stats", async (_req, res) => {
  const panelStats = await store.getPanelStats();
  const cases = await caseStore.listCases();
  const [orders, notifications] = await Promise.all([fulfillmentStore.listOrders(), fulfillmentStore.listNotifications()]);
  const toolCallsThisSession = missionControlLog
    .getRecentEvents(DEFAULT_MAX_EVENTS)
    .filter((e) => e.type === "tool_call").length;
  res.json({
    ...panelStats,
    toolCallsThisSession,
    totalCases: cases.length,
    resolvedCases: cases.filter((c) => c.status === "resolved").length,
    liveEvidenceCases: cases.filter((c) => c.evidence?.source === "fda_live").length,
    inventoryChecks: cases.filter((c) => c.fulfillment?.lastCheckedStock != null || c.fulfillment?.stockAtOrder != null).length,
    ordersPlaced: orders.length,
    notificationsSent: notifications.length,
  });
});

// ---- Chat API: drives the TrueForge agent, streamed to the browser ----

/**
 * Processes one turn's real events - model deltas, tool calls, tool
 * results, approval-required pauses, turn completion - updating the case
 * store and Mission Control's live event feed as it goes. `send` is how
 * each event reaches a live client; for a real person's chat that's an SSE
 * write, for an autonomously-triggered fulfillment turn (no one
 * necessarily watching) it's a no-op, since the case store and event log
 * still update either way and are what the UI actually polls.
 */
async function processTurn(send, sessionId, inputItems) {
  try {
    const stream = await trueforge.sessions.createTurnStream(sessionId, { input: inputItems });

    // Accumulates streamed tool-call fragments into complete calls with a
    // stable id, even across the several separate rounds of tool calls one
    // turn can contain (see tool-call-accumulator.mjs for why that's not
    // just a Map keyed by stream index).
    const toolCalls = createToolCallAccumulator();
    const loggedCalls = new Set();

    for await (const event of stream) {
      switch (event.type) {
        case "model.message.delta": {
          if (event.content) send("delta", { text: event.content });
          for (const tc of event.toolCalls ?? []) {
            const call = toolCalls.applyDelta(tc);
            if (!call.name) continue;
            send("tool_call", { id: call.id, name: call.name, args: call.args });
            if (!loggedCalls.has(call)) {
              loggedCalls.add(call);
              missionControlLog.addEvent({
                type: "tool_call",
                label: `${describeToolServer(call.name)} MCP - calling ${call.name}`,
              });
            }
          }
          break;
        }
        case "tool.response": {
          send("tool_result", { toolCallId: event.toolCallId, content: event.content });
          missionControlLog.addEvent({ type: "tool_result", label: summarizeToolResult(event.content) });

          // If this was a case-mutating action, log the case's real
          // resulting state rather than assuming success - the MCP server
          // is the one that actually resolved (or ordered, or proposed
          // for) it. TrueForge may route the model's invocation directly
          // or through its own call_tool meta-tool, so resolve the real
          // tool name/args either way.
          const resolved = resolveActualToolCall(toolCalls.getById(event.toolCallId));
          if (CASE_MUTATING_TOOLS.has(resolved?.name)) {
            try {
              const { caseId } = JSON.parse(resolved.args || "{}");
              const kase = caseId && (await caseStore.getCase(caseId));
              if (kase) {
                missionControlLog.addEvent({ type: "case_update", label: `Case ${kase.id}: ${kase.status}` });
              }
            } catch {
              // Malformed tool-call args shouldn't crash the stream relay.
            }
          }
          toolCalls.complete(event.toolCallId);
          break;
        }
        case "tool.approval_required": {
          for (const tc of event.toolCalls ?? []) {
            const resolved = resolveActualToolCall(toolCalls.getById(tc.id));
            if (!APPROVAL_GATED_TOOLS.has(resolved?.name)) continue;
            try {
              const { caseId, note, alternativeDrugName } = JSON.parse(resolved.args || "{}");
              if (!caseId) continue;
              await caseStore.requestApprovalForCase(caseId, {
                toolCallId: tc.id,
                threadId: event.threadId,
                sessionId,
                note,
                alternativeDrugName,
              });
              send("approval_required", { caseId, note, alternativeDrugName });
              missionControlLog.addEvent({ type: "approval_required", label: `Approval required for case ${caseId}` });
            } catch {
              // Malformed tool-call args shouldn't crash the stream relay.
            }
          }
          break;
        }
        case "turn.done": {
          const status = event.state?.status ?? "done";
          if (status === "error") {
            send("error", { message: event.state.message || "The agent hit an error completing that turn." });
          }
          send("done", { status });
          missionControlLog.addEvent({
            type: "turn_done",
            label: status === "error" ? "Turn failed" : "Turn completed",
          });
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    console.error("Turn processing error:", err);
    send("error", { message: err.message ?? String(err) });
    missionControlLog.addEvent({ type: "turn_done", label: "Turn failed" });
  }
}

/** Streams a real person's turn to the browser as SSE, on top of the shared processTurn core. */
async function runTurn(res, sessionId, inputItems) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    await processTurn(send, sessionId, inputItems);
  } finally {
    res.end();
  }
}

/**
 * Runs a turn with no live client attached - used when PharmaFlow starts
 * itself (a newly detected supply-risk case), not a person typing in
 * chat. Nothing is streamed anywhere; the real case-store and event-log
 * updates processTurn already makes are what the UI polls to show it
 * happening "live".
 */
async function runBackgroundTurn(sessionId, inputItems) {
  await processTurn(() => {}, sessionId, inputItems);
}

app.post("/api/chat", async (req, res) => {
  const { message, conversationId } = req.body ?? {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

  let sessionId = conversationId && conversationSessions.get(conversationId);
  if (!sessionId) {
    const { data: session } = await trueforge.sessions.create({ agent: { name: AGENT_NAME } });
    sessionId = session.id;
    if (conversationId) conversationSessions.set(conversationId, sessionId);
    missionControlLog.addEvent({ type: "session", label: "New chat session started" });
  }
  res.write(`event: session\ndata: ${JSON.stringify({ conversationId: conversationId ?? sessionId, sessionId })}\n\n`);

  await runTurn(res, sessionId, [{ type: "user.message", content: message }]);
});

// Resumes a paused turn after a human approve/reject decision. Resolves
// entirely from the case's own durable record (sessionId/threadId/
// toolCallId), not from any in-memory conversation state - so it survives
// a page reload, and even a backend restart, on its own.
app.post("/api/chat/approval", async (req, res) => {
  const { caseId, decision, reason } = req.body ?? {};
  if (!caseId || (decision !== "allow" && decision !== "deny")) {
    return res.status(400).json({ error: "caseId and decision ('allow' | 'deny') are required" });
  }

  const kase = await caseStore.getCase(caseId);
  if (!kase || kase.status !== "approval_required" || !kase.pendingApproval) {
    return res.status(400).json({ error: `Case ${caseId} has no pending approval` });
  }
  const { toolCallId, threadId, sessionId } = kase.pendingApproval;

  if (decision === "deny") {
    // A denial never reaches the tool handler, so nothing else will ever
    // record this outcome - the case is reopened here, proactively.
    await caseStore.resolveCaseAfterAction(caseId, { approved: false, reason });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const approval = decision === "allow" ? { status: "allow" } : { status: "deny", reason };
  await runTurn(res, sessionId, [{ type: "user.tool_approval", threadId, toolCallId, approval }]);
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "pharmaflow-backend" }));

app.listen(PORT, () => {
  console.log(`PharmaFlow dashboard listening on http://localhost:${PORT}`);
});
