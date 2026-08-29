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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

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

// ---- Cases: real detections only, real lifecycle transitions only ----

app.get("/api/cases", async (_req, res) => {
  try {
    const cases = await reconcileCasesFromLiveData(caseStore);
    agentStatus.recordCheck("fda");
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
  const toolCallsThisSession = missionControlLog
    .getRecentEvents(DEFAULT_MAX_EVENTS)
    .filter((e) => e.type === "tool_call").length;
  res.json({ ...panelStats, toolCallsThisSession });
});

// ---- Chat API: drives the TrueForge agent, streamed to the browser ----

/**
 * Streams one turn (a new user message, or a resumed approval decision) to
 * the browser as SSE, logging real Mission Control events as it goes.
 * Shared by /api/chat and /api/chat/approval so both paths handle model
 * deltas, tool calls, tool results, approval-required pauses, and turn
 * completion exactly the same way.
 */
async function runTurn(res, sessionId, inputItems) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

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

          // If this was the pharmacist-review action, log the case's real
          // resulting state rather than assuming success - the MCP server
          // is the one that actually resolved it. TrueForge may route the
          // model's invocation directly or through its own call_tool
          // meta-tool, so resolve the real tool name/args either way.
          const resolved = resolveActualToolCall(toolCalls.getById(event.toolCallId));
          if (resolved?.name === "create_pharmacist_review") {
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
            if (resolved?.name !== "create_pharmacist_review") continue;
            try {
              const { caseId, note } = JSON.parse(resolved.args || "{}");
              if (!caseId) continue;
              await caseStore.requestApprovalForCase(caseId, {
                toolCallId: tc.id,
                threadId: event.threadId,
                sessionId,
              });
              send("approval_required", { caseId, note });
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
    console.error("Chat error:", err);
    send("error", { message: err.message ?? String(err) });
  } finally {
    res.end();
  }
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
