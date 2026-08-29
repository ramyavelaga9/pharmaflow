# PharmaFlow — Medication Continuity Agent

PharmaFlow helps a care-coordination team catch medication continuity
problems before they become crises: refill gaps, drug-drug interaction
risk, and adherence drop-off across a patient panel. It's built on
[TrueForge](https://github.com/truefoundry/trueforge), the open-source
agent harness, for the [Agent Harness Hackathon](https://www.wemakedevs.org/blogs/agent-harness-hackathon-kick-off).

## Why this is a TrueForge project, not just an LLM wrapper

The hackathon's framing is that generating text is the easy part; reliably
doing real work (retrieving external data, calling tools, taking actions
with a human in the loop) is the hard part. PharmaFlow's agent:

- **Retrieves real data through tools, not its own memory.** A custom MCP
  server (`src/mcp-server.mjs`) exposes patient records, refill status,
  interaction checks, and dose logging as tools; the agent has to call
  them, it can't invent a patient's medication list.
- **Follows a written procedure**, not just a system prompt. The
  `medication-continuity` skill (`skills/medication-continuity/SKILL.md`)
  is a git-backed instruction pack TrueForge loads at runtime.
- **Takes a real, persisted action** (`log_dose`) when asked, shared with
  the dashboard through the same on-disk data store, so an action the
  agent takes is immediately visible in the UI and vice versa.
- **Runs on the harness, not around it.** Model provider, MCP server,
  skill, and agent are all registered on a locally running TrueForge
  instance via its REST API (`src/setup-trueforge.mjs`), and the web
  backend drives conversations through the TrueForge TypeScript SDK
  (`@truefoundry/trueforge-sdk`), streaming turns straight to the browser.

## Architecture

```
┌─────────────┐      REST (dashboard data)      ┌──────────────────┐
│  Browser UI │ ───────────────────────────────▶│ PharmaFlow backend│
│ (web/*.html,│                                  │  (src/backend.mjs)│
│  css, js)   │◀───── SSE (agent chat turns) ────│  Express + SDK    │
└─────────────┘                                  └────────┬─────────┘
                                                            │ TrueForge SDK
                                                            ▼
                                              ┌───────────────────────────┐
                                              │   TrueForge (harness)     │
                                              │ npx @truefoundry/trueforge│
                                              │  agent: "pharmaflow"      │
                                              └─────────┬─────────┬───────┘
                                                         │         │
                                              MCP (HTTP) │         │ git clone
                                                         ▼         ▼
                                        ┌──────────────────┐  ┌───────────────────────┐
                                        │ PharmaFlow MCP    │  │ medication-continuity  │
                                        │ tool server        │  │ SKILL.md               │
                                        │ (src/mcp-server.mjs)│  └───────────────────────┘
                                        └─────────┬──────────┘
                                                   ▼
                                        ┌──────────────────────┐
                                        │ data/patients.json    │
                                        │ data/interactions.json│
                                        └──────────────────────┘
```

Both the dashboard's REST API and the MCP tool server read and write the
same JSON files (`src/store.mjs`), so it's a genuinely shared source of
truth rather than two demos glued together.

## Running it locally

Requires Node.js 22+.

```bash
npm install
cp .env.example .env        # then put a real OPENAI_API_KEY in .env

# Terminal 1: the TrueForge harness itself
npx @truefoundry/trueforge@latest

# Terminal 2: PharmaFlow's MCP tool server
npm run mcp

# Terminal 3: register the model/MCP server/skill/agent on TrueForge,
# then start the dashboard backend
npm run setup
npm run backend
```

Open **http://localhost:8787** for the PharmaFlow dashboard (patient
panel, refill/interaction alerts, an "Ask PharmaFlow" chat drawer), or
the TrueForge chat UI directly at **http://localhost:8790**.

`npm run setup` is safe to re-run any time (e.g. after adding a real API
key, or once the skill's GitHub URL is set via
`PHARMAFLOW_SKILL_REPO_URL`) — it updates existing resources instead of
duplicating them.

## Project layout

```
data/                    mock patient panel + drug-interaction table
skills/medication-continuity/SKILL.md   agent procedure (git-backed skill)
src/store.mjs            shared data layer (refill math, interactions, adherence)
src/mcp-server.mjs       MCP tool server exposing store.mjs to the agent
src/backend.mjs          dashboard REST API + /api/chat SSE bridge to TrueForge
src/setup-trueforge.mjs  registers provider/MCP server/skill/agent via REST
web/                     plain HTML/CSS/JS dashboard (no build step)
```

## Qodo Code Review Evidence

_To be filled in after the PR is reviewed on [app.qodo.ai](https://app.qodo.ai):
link to the review, and note how any high-severity findings were addressed
or intentionally dismissed._

## Status / scope

This is a hackathon prototype: patient data is a small mocked panel (not a
real EHR integration), and the drug-interaction table is a short
illustrative list, not a clinical decision-support database. It should not
be used for real medication decisions.
