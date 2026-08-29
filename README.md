# PharmaFlow — Medication Continuity Agent

PharmaFlow helps a care-coordination team catch medication continuity
problems before they become crises: refill gaps, drug-drug interaction
risk, adherence drop-off, and real FDA supply-shortage exposure across a
patient panel. It's built on
[TrueForge](https://github.com/truefoundry/trueforge), the open-source
agent harness, for the [Agent Harness Hackathon](https://www.wemakedevs.org/blogs/agent-harness-hackathon-kick-off).

## Why this is a TrueForge project, not just an LLM wrapper

The hackathon's framing is that generating text is the easy part; reliably
doing real work (retrieving external data, calling tools, taking actions
with a human in the loop) is the hard part. PharmaFlow's agent:

- **Retrieves real data through tools, not its own memory.** Two domain-
  scoped MCP servers — `src/mcp-server.mjs` (patient records, refill
  status, interaction checks, dose logging) and `src/fda-mcp-server.mjs`
  (live openFDA drug-shortage lookups) — the agent has to call them, it
  can't invent a patient's medication list or a shortage that doesn't exist.
- **Uses real external data, honestly labeled.** `src/fda.mjs` queries
  openFDA's live shortage API and falls back to a small, clearly labeled
  demo fixture only when the live API is genuinely unreachable — every
  record carries `source: "fda_live" | "demo"` so nothing downstream can
  blur a synthetic fallback into a live FDA claim.
- **Follows a written procedure**, not just a system prompt. The
  `medication-continuity` and `shortage-analysis` skills
  (`skills/*/SKILL.md`) are git-backed instruction packs TrueForge loads
  at runtime — including an explicit instruction to never infer a
  medication substitution, matching the hackathon's safety requirements.
- **Takes a real, persisted action** (`log_dose`) when asked, shared with
  the dashboard through the same on-disk data store, so an action the
  agent takes is immediately visible in the UI and vice versa.
- **Runs on the harness, not around it.** Model provider, both MCP
  servers, both skills, and the agent are all registered on a locally
  running TrueForge instance via its REST API
  (`src/setup-trueforge.mjs`), and the web backend drives conversations
  through the TrueForge TypeScript SDK (`@truefoundry/trueforge-sdk`),
  streaming turns straight to the browser.
- **Reports only real agent activity.** The dashboard's Mission Control
  tab shows a live event feed and stat tiles sourced from actual chat
  session/tool-call events (`src/event-log.mjs`) and the same panel-stats
  computation the Patient Panel tab uses — never an invented score or a
  simulated event that didn't happen.

## Architecture

```
┌─────────────┐   REST (dashboard data, supply risk, mission control)   ┌────────────────────┐
│  Browser UI │ ───────────────────────────────────────────────────────▶│ PharmaFlow backend  │
│ (web/*.html,│                                                          │  (src/backend.mjs)  │
│  css, js)   │◀───────────────── SSE (agent chat turns) ────────────────│  Express + SDK      │
└─────────────┘                                                          └──────────┬──────────┘
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
                              ┌──────────────────────┐            ┌───────────────────────────┐
                              │ data/patients.json    │            │ api.fda.gov/drug/shortages │
                              │ data/interactions.json│            │ (falls back to a labeled   │
                              └──────────────────────┘             │  demo fixture if unreachable)│
                                                                    └───────────────────────────┘
```

Both the dashboard's REST API and the PharmaFlow MCP tool server read and
write the same JSON files (`src/store.mjs`), so it's a genuinely shared
source of truth rather than two demos glued together.

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

Open **http://localhost:8787** for the PharmaFlow dashboard — a
**Patient Panel** tab (refill/interaction/supply-risk alerts, an "Ask
PharmaFlow" chat drawer) and a **Mission Control** tab (real session
stats, a live event feed, and the agent's current execution path) — or
the TrueForge chat UI directly at **http://localhost:8790**.

`npm run setup` is safe to re-run any time (e.g. after adding a real API
key, or once the skills' GitHub URL is set via
`PHARMAFLOW_SKILL_REPO_URL`) — it updates existing resources instead of
duplicating them.

## Tests

```bash
npm test
```

Runs on Node's built-in test runner (`node --test`, no extra dependency).
Covers the data-correctness edge cases that matter most here: openFDA's
404-as-"no matches" convention, live-API-unreachable → labeled demo
fallback, drug-name normalization (including a false-positive-avoidance
case), `MM/DD/YYYY` date parsing for the supply-risk dedup logic, refill
status bucketing at day boundaries, and a rejection path for an unknown
patient/medication.

## Project layout

```
data/                          mock patient panel, drug-interaction table, demo FDA fixture
skills/medication-continuity/  agent procedure: refills, interactions, adherence
skills/shortage-analysis/      agent procedure: FDA shortages, never infer a substitution
src/store.mjs                  shared data layer (refill math, interactions, adherence, panel stats)
src/fda.mjs                    openFDA shortage lookups, with the live/demo fallback
src/event-log.mjs              capped in-memory ring buffer for Mission Control's live feed
src/mcp-server.mjs             MCP tool server: patient data
src/fda-mcp-server.mjs         MCP tool server: FDA shortage data
src/backend.mjs                dashboard REST API + /api/chat SSE bridge to TrueForge
src/setup-trueforge.mjs        registers providers/MCP servers/skills/agent via REST
web/                           plain HTML/CSS/JS dashboard (no build step)
test/                          node:test suites for fda.mjs, event-log.mjs, store.mjs
```

## Scope trims (deliberate, not oversights)

- `get_drug_shortage(id)` (drill-down by FDA record id) was dropped from
  the FDA MCP server — nothing in the app needs it yet, and adding it
  now would just be an untested, unused code path.
- The orchestrator + specialized-subagent split (Supply / Patient-Impact /
  Inventory / Safety), sandbox-based multi-day stockout simulation,
  persistent SQLite case model, and gamification metrics described in the
  full design brief are later milestones, not this slice — Mission
  Control's stat tiles and execution graph intentionally show only what's
  real today rather than a preview of agents that don't exist yet.

## Qodo Code Review Evidence

_To be filled in after the PR is reviewed on [app.qodo.ai](https://app.qodo.ai):
link to the review, and note how any high-severity findings were addressed
or intentionally dismissed._

## Status / scope

This is a hackathon prototype: patient data is a small mocked panel (not a
real EHR integration), and the drug-interaction table is a short
illustrative list, not a clinical decision-support database. It should not
be used for real medication decisions.
