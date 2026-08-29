# PharmaFlow — Medication Continuity Agent

PharmaFlow helps a care-coordination team catch medication continuity
problems before they become crises: refill gaps, drug-drug interaction
risk, adherence drop-off, and real FDA supply-shortage exposure across a
patient panel. When something genuinely needs a pharmacist's attention,
PharmaFlow proposes a real action and **stops for human approval** before
it happens. It's built on
[TrueForge](https://github.com/truefoundry/trueforge), the open-source
agent harness, for the [Agent Harness Hackathon](https://www.wemakedevs.org/blogs/agent-harness-hackathon-kick-off).

## Why this is a TrueForge project, not just an LLM wrapper

The hackathon's framing is that generating text is the easy part; reliably
doing real work (retrieving external data, calling tools, taking actions
with a human in the loop) is the hard part. PharmaFlow's agent:

- **Retrieves real data through tools, not its own memory.** Two domain-
  scoped MCP servers — `src/mcp-server.mjs` (patient records, refill
  status, interaction checks, dose logging, case lookup, pharmacist
  review) and `src/fda-mcp-server.mjs` (live openFDA drug-shortage
  lookups) — the agent has to call them, it can't invent a patient's
  medication list, a case id, or a shortage that doesn't exist.
- **Uses real external data, honestly labeled.** `src/fda.mjs` queries
  openFDA's live shortage *and* recall (enforcement) APIs and falls back to
  a small, clearly labeled demo fixture only when the live API is
  genuinely unreachable — every record carries `source: "fda_live" | "demo"`
  so nothing downstream can blur a synthetic fallback into a live FDA
  claim. Only *active* records count (`status: "Ongoing"` for a recall,
  not-yet-resolved for a shortage) — a terminated recall is history, not
  a live one.
- **Follows a written procedure**, not just a system prompt. The
  `medication-continuity` and `shortage-analysis` skills
  (`skills/*/SKILL.md`) are git-backed instruction packs TrueForge loads
  at runtime — including an explicit instruction to never infer a
  medication substitution, matching the hackathon's safety requirements.
- **Stops for real human approval before a consequential action.**
  `create_pharmacist_review` is configured on the agent's manifest as a
  tool requiring explicit approval (`require_approval_for_tools`) - not a
  decorative UI button. TrueForge genuinely pauses the turn; the browser
  shows the real pending approval (persisted on the case itself, so it
  survives a reload); approving or rejecting resumes that exact paused
  turn via the TrueForge SDK. See "Case lifecycle" below.
- **Maintains real, persisted cases**, not a mocked lifecycle. A case is
  created only when a real supply-risk or high-severity interaction hit
  exists, and only moves between `detected` / `approval_required` /
  `resolved` on real events (`src/cases.mjs`, `src/case-triggers.mjs`).
- **Runs on the harness, not around it.** Model provider, both MCP
  servers, both skills, and the agent are all registered on a locally
  running TrueForge instance via its REST API
  (`src/setup-trueforge.mjs`), and the web backend drives conversations
  through the TrueForge TypeScript SDK (`@truefoundry/trueforge-sdk`),
  streaming turns straight to the browser.
- **Reports only real agent activity.** Mission Control's live event feed,
  stat tiles, and per-source "last checked" timestamps are all sourced
  from actual chat/tool-call events (`src/event-log.mjs`,
  `src/agent-status.mjs`) and the same data the Patient Panel tab uses —
  never an invented score or a simulated event that didn't happen.

## Case lifecycle

```
 real supply-risk / high-severity     agent calls create_pharmacist_review    a person
   interaction detected                 (TrueForge pauses the turn)          approves/rejects
        │                                        │                                │
        ▼                                        ▼                                ▼
    DETECTED  ─────────────────────────▶  APPROVAL_REQUIRED  ──────┬────────▶  RESOLVED (approved)
        ▲                                                          │
        └──────────────────────────────────────────────────────── ┴────────▶  DETECTED (rejected -
             a case is reopened, never silently closed, on reject                reopened, not closed)
```

A case whose trigger clears on its own (e.g. the FDA record disappears)
auto-resolves — but only from `detected`; a case already awaiting a human
decision, or already resolved, is never overwritten by a live-data blip.

## Architecture

```
┌─────────────┐   REST (dashboard data, cases, agent status)   ┌────────────────────┐
│  Browser UI │ ────────────────────────────────────────────────▶│ PharmaFlow backend  │
│ (web/*.html,│                                                   │  (src/backend.mjs)  │
│  css, js)   │◀────── SSE (chat turns + approval resume) ────────│  Express + SDK      │
└─────────────┘                                                   └──────────┬──────────┘
                                                                              │ TrueForge SDK
                                                                              ▼
                                                            ┌───────────────────────────┐
                                                            │   TrueForge (harness)     │
                                                            │ npx @truefoundry/trueforge│
                                                            │  agent: "pharmaflow"      │
                                                            └─────────┬────────┬────────┘
                                                                      │        │
                                                           MCP (HTTP)│        │ git clone
                                       ┌──────────────────────────────┴──┐  ┌──┴─────────────────────┐
                                       │                                 │  │ medication-continuity /  │
                                       ▼                                 ▼  │ shortage-analysis SKILL.md│
                       ┌────────────────────────┐        ┌────────────────────────┐ └──────────────────┘
                       │ PharmaFlow MCP           │        │ FDA MCP                 │
                       │ (src/mcp-server.mjs)     │        │ (src/fda-mcp-server.mjs) │
                       └───────────┬──────────────┘        └───────────┬──────────────┘
                                   ▼                                   ▼
                       ┌──────────────────────────┐         ┌───────────────────────────┐
                       │ data/patients.json,       │         │ api.fda.gov/drug/shortages │
                       │ interactions.json, cases.json│      │ (labeled demo fallback)    │
                       └──────────────────────────┘          └───────────────────────────┘
```

Both the dashboard's REST API and the pharmacy MCP server read and write
the same JSON files (`src/store.mjs`, `src/cases.mjs`) — a genuinely
shared source of truth, and the reason `create_pharmacist_review`
resolving a case from the *MCP server's own process* is immediately
visible on the dashboard.

### Two real TrueForge behaviors worth knowing before you extend this

Found by testing against the live harness with a real model, not assumed
from docs:

- **TrueForge can route a tool call through its own `call_tool` meta-tool**
  (`{mcp_server, tool_name, input}`) rather than the model calling a tool
  by name directly — the same progressive-disclosure pattern this coding
  session's own tools use. Anything that needs to recognize a specific
  tool call (like approval-gating logic) has to check both shapes -
  `src/tool-call-accumulator.mjs`'s `resolveActualToolCall` does this.
- **The turn-input wire format for resuming a paused turn uses camelCase**
  (`threadId`, `toolCallId`), not the snake_case shown in the cached
  OpenAPI schema we initially checked against. Validated by the server's
  own validation error, not by re-reading docs.

## Running it locally

Requires Node.js 22+.

```bash
npm install
cp .env.example .env        # then put a real OPENAI_API_KEY in .env

# Terminal 1: the TrueForge harness itself
npx @truefoundry/trueforge@latest

# Terminal 2 & 3: PharmaFlow's MCP tool servers
npm run mcp
npm run fda-mcp

# Terminal 4: register the model/MCP servers/skills/agent on TrueForge,
# then start the dashboard backend
npm run setup
npm run backend
```

Open **http://localhost:8787** for the PharmaFlow dashboard: **Drug Panel**
is the default tab (the command-center title, a live agent-status strip,
and every medication on the panel with its real active FDA shortage/recall
status and who's affected - click a drug for full detail, expands inline
accordion-style), then **Patient Panel** (a supply-risk summary, refill/
interaction alerts, an "Open Agent" chat drawer), and **Mission Control**
(real case list with case detail + approve/reject,
a live event feed, and the agent's current execution path) — or the
TrueForge chat UI directly at **http://localhost:8790**.

`npm run setup` is safe to re-run any time (e.g. after adding a real API
key, or once the skills' GitHub URL is set via
`PHARMAFLOW_SKILL_REPO_URL`) — it updates existing resources instead of
duplicating them.

## Tests

```bash
npm test
```

Runs on Node's built-in test runner (`node --test`, no extra dependency).
52 tests covering: openFDA's 404-as-"no matches" convention, live-API-
unreachable → labeled demo fallback, drug-name normalization (including a
false-positive-avoidance case), `MM/DD/YYYY` date parsing, refill-status
day boundaries, case reconciliation (creation, dedup, auto-resolve, and
the rule that a pending-approval or already-resolved case is never
silently overwritten), and the tool-call accumulator that fixes a real
bug found via live testing: a later round of tool calls reusing a stream
index used to silently concatenate onto an earlier, finished call's name
and arguments.

## Project layout

```
data/                          mock patient panel, interaction table, demo FDA fixtures, cases
skills/medication-continuity/  agent procedure: refills, interactions, adherence, escalation
skills/shortage-analysis/      agent procedure: FDA shortages, never infer a substitution
src/store.mjs                  shared data layer (refill math, interactions, adherence, panel stats)
src/fda.mjs                    openFDA shortage + recall lookups, with the live/demo fallback
src/drug-panel.mjs             drug-centric view: real patients per drug, shortage/recall status
src/cases.mjs                  case store: reconciliation, approval request/resolution
src/case-triggers.mjs          pure: real alerts -> case triggers (supply-risk, high interactions)
src/case-reconciliation.mjs    shared by backend + MCP server: live alerts -> reconciled cases
src/tool-call-accumulator.mjs  streamed tool-call accumulation + call_tool unwrapping
src/tool-telemetry.mjs         which MCP server a tool belongs to; honest result summaries
src/event-log.mjs              capped in-memory ring buffer for Mission Control's live feed
src/agent-status.mjs           real "last checked per source" tracking, no hardcoded timestamps
src/mcp-server.mjs             MCP tool server: patient data, cases, pharmacist review
src/fda-mcp-server.mjs         MCP tool server: FDA shortage data
src/backend.mjs                dashboard REST API + /api/chat, /api/chat/approval SSE bridges
src/setup-trueforge.mjs        registers providers/MCP servers/skills/agent via REST
web/                           plain HTML/CSS/JS dashboard (no build step)
test/                          node:test suites, one per src module above
```

## Scope trims (deliberate, not oversights)

- `get_drug_shortage(id)` (drill-down by FDA record id) was dropped from
  the FDA MCP server — nothing in the app needs it yet.
- The orchestrator + specialized-subagent split (Supply / Patient-Impact /
  Inventory / Safety), a real orchestration graph, pharmacy inventory data,
  sandbox-based multi-day stockout simulation, gamification metrics, and
  mission replay from the full design brief are later milestones. Mission
  Control's execution graph intentionally shows only the single agent +
  two MCP servers that actually run today, not a preview of agents that
  don't exist yet — the same reason the case lifecycle here is 3 real
  stages, not the full 8-stage one in the brief.
- The approve/reject action lives in Mission Control's case detail (not
  duplicated in the chat drawer) since `/api/chat/approval` resolves
  entirely from the case's own durable record — one real place to act,
  not two UIs racing to resolve the same pending decision.

## Qodo Code Review Evidence

_To be filled in after the PR is reviewed on [app.qodo.ai](https://app.qodo.ai):
link to the review, and note how any high-severity findings were addressed
or intentionally dismissed._

## Status / scope

This is a hackathon prototype: patient data is a small mocked panel (not a
real EHR integration), and the drug-interaction table is a short
illustrative list, not a clinical decision-support database. It should not
be used for real medication decisions.
