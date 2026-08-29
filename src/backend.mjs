// PharmaFlow web backend.
//
// Serves the dashboard UI and a small REST API that reads/writes the shared
// patient data directly (fast, no LLM round-trip needed for the dashboard
// itself), plus /api/chat which drives the "pharmaflow" TrueForge agent and
// relays its streamed turn as Server-Sent Events to the browser.

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import * as store from "./store.mjs";
import * as fda from "./fda.mjs";
import { createEventLog, DEFAULT_MAX_EVENTS } from "./event-log.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const TRUEFORGE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const AGENT_NAME = process.env.PHARMAFLOW_AGENT_NAME || "pharmaflow";

const trueforge = new TrueForge({ baseUrl: TRUEFORGE_URL, timeoutInSeconds: 120 });

// conversationId (browser-generated) -> TrueForge session id, so a chat
// keeps context across turns without the browser needing to know anything
// about TrueForge's session model.
const conversationSessions = new Map();

// Real agent activity (session start, tool calls, tool results, turn
// completion), for the Mission Control tab's live event feed.
const missionControlLog = createEventLog();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

// ---- Dashboard REST API (no LLM involved — instant, always available) ----

app.get("/api/patients", async (_req, res) => {
  res.json(await store.listPatients());
});

app.get("/api/patients/:id", async (req, res) => {
  const patient = await store.getPatient(req.params.id);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  res.json(patient);
});

app.get("/api/refill-alerts", async (req, res) => {
  const daysAhead = Number(req.query.days) || 7;
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

// Cross-references every medication on the panel against real (or, if the
// live API is unreachable, clearly labeled demo) FDA shortage data.
app.get("/api/supply-risk", async (_req, res) => {
  try {
    const patients = await store.loadPatients();
    const uniqueMedNames = [...new Set(patients.flatMap((p) => p.medications.map((m) => m.name)))];
    const shortagesByMed = new Map(
      await Promise.all(uniqueMedNames.map(async (name) => [name, await fda.searchDrugShortages(name)]))
    );

    // openFDA reports shortages per package/NDC, so one drug can return
    // several near-identical records; the panel only needs one row per
    // patient+medication, so keep just the most recently updated.
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
    res.json([...alertsByKey.values()]);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Mission Control: real agent activity, not a mock of a bigger system ----

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

app.post("/api/chat", async (req, res) => {
  const { message, conversationId } = req.body ?? {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    let sessionId = conversationId && conversationSessions.get(conversationId);
    if (!sessionId) {
      const { data: session } = await trueforge.sessions.create({ agent: { name: AGENT_NAME } });
      sessionId = session.id;
      if (conversationId) conversationSessions.set(conversationId, sessionId);
      missionControlLog.addEvent({ type: "session", label: "New chat session started" });
    }
    send("session", { conversationId: conversationId ?? sessionId, sessionId });

    const stream = await trueforge.sessions.createTurnStream(sessionId, {
      input: [{ type: "user.message", content: message }],
    });

    // Accumulate streamed tool-call fragments (OpenAI-style deltas: name and
    // arguments arrive in pieces across events) so the UI can show "calling
    // get_refill_alerts(...)"-style status without waiting for the full turn.
    const pendingToolCalls = new Map();
    const loggedToolCalls = new Set();

    for await (const event of stream) {
      switch (event.type) {
        case "model.message.delta": {
          if (event.content) send("delta", { text: event.content });
          for (const tc of event.toolCalls ?? []) {
            const idx = tc.index ?? 0;
            const acc = pendingToolCalls.get(idx) ?? { name: "", args: "" };
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            pendingToolCalls.set(idx, acc);
            if (acc.name) {
              send("tool_call", { id: tc.id ?? String(idx), name: acc.name, args: acc.args });
              if (!loggedToolCalls.has(idx)) {
                loggedToolCalls.add(idx);
                missionControlLog.addEvent({ type: "tool_call", label: `Calling ${acc.name}` });
              }
            }
          }
          break;
        }
        case "tool.response": {
          send("tool_result", { toolCallId: event.toolCallId, content: event.content });
          missionControlLog.addEvent({ type: "tool_result", label: "Tool result received" });
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
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "pharmaflow-backend" }));

app.listen(PORT, () => {
  console.log(`PharmaFlow dashboard listening on http://localhost:${PORT}`);
});
