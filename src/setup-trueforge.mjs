// One-shot setup script: registers PharmaFlow's model provider, MCP
// servers, skills, and agent on a locally running TrueForge instance via
// its REST API, so the whole harness config is code (reviewable,
// reproducible) instead of manual clicking through Settings.
//
// Prereqs:
//   1. TrueForge running locally: `npx @truefoundry/trueforge@latest`
//   2. PharmaFlow's MCP servers running: `npm run mcp` and `npm run fda-mcp`
//   3. OPENAI_API_KEY set in .env (a placeholder key still lets you register
//      everything and wire it up — the agent just won't answer for real
//      until you swap in a working key and re-run this script)
//
// Safe to re-run: existing resources are updated in place rather than
// duplicated.

import "dotenv/config";

const BASE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const MCP_URL = process.env.PHARMAFLOW_MCP_URL || "http://localhost:8791/mcp";
const FDA_MCP_URL = process.env.PHARMAFLOW_FDA_MCP_URL || "http://localhost:8792/mcp";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-placeholder-replace-me";
const SKILL_REPO_URL = process.env.PHARMAFLOW_SKILL_REPO_URL || "";
const SKILL_REPO_REF = process.env.PHARMAFLOW_SKILL_REPO_REF || "main";

const MODEL_NAME = "openai/gpt-5-5";
const AGENT_NAME = "pharmaflow";

const MCP_SERVERS = [
  {
    name: "pharmaflow-tools",
    url: MCP_URL,
    description: "PharmaFlow patient data: refill status, interactions, adherence, dose logging.",
  },
  {
    name: "fda-shortages",
    url: FDA_MCP_URL,
    description: "Real openFDA drug shortage lookups, with a labeled live/demo fallback.",
  },
];

// Per-server settings on the agent itself (distinct from MCP_SERVERS above,
// which registers the servers as harness-wide resources). create_pharmacist_review
// is named explicitly rather than relying on the "@write"/"@destructive"
// default categories, so approval-gating doesn't depend on annotation
// heuristics working out.
const AGENT_MCP_SERVERS = [
  { name: "pharmaflow-tools", require_approval_for_tools: ["create_pharmacist_review"] },
  { name: "fda-shortages" },
];

const SKILLS = [
  {
    name: "medication-continuity",
    path: "skills/medication-continuity",
    description: "Review a patient's regimen for refill gaps, interaction risk, and adherence problems.",
  },
  {
    name: "shortage-analysis",
    path: "skills/shortage-analysis",
    description: "Check whether a current FDA drug shortage affects any patient on the panel.",
  },
];

const AGENT_INSTRUCTIONS = `You are PharmaFlow, a medication continuity assistant for a care
coordination team. You help staff spot refill gaps, drug interaction risk,
adherence problems, and FDA supply-shortage exposure across a patient panel
before they become crises.

Always ground answers in the pharmaflow-tools and fda-shortages MCP tools,
and the medication-continuity and shortage-analysis skills — never invent
patient data or FDA records. When reporting a shortage, always say whether
it came from live FDA data or a demo fixture. If a question is ambiguous
about which patient is meant, ask before guessing.

When a medication continuity case (a real detected supply-risk or
interaction-risk issue, identified via its "PF-" case id) genuinely needs
pharmacist attention, call create_pharmacist_review with that case id and a
short, concrete note. This requires human approval and will pause until a
person responds - never treat it as a routine next step, and never call it
speculatively "just in case."`;

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${json?.error?.message ?? JSON.stringify(json)}`);
  }
  return json;
}

/** POST-then-PUT-on-conflict against one of TrueForge's Settings collections. */
async function upsertViaSettings(endpoint, manifest, label) {
  try {
    await call("POST", `/api/v1/settings/${endpoint}`, { manifest });
    console.log(`✓ registered ${label}`);
  } catch (err) {
    if (/exists/i.test(err.message)) {
      await call("PUT", `/api/v1/settings/${endpoint}`, { manifest });
      console.log(`✓ updated ${label}`);
    } else {
      throw err;
    }
  }
}

async function upsertModelProvider() {
  const manifest = {
    type: "openai",
    auth: { api_key: OPENAI_API_KEY },
    models: [
      {
        model_id: "gpt-5.5",
        name: "gpt-5-5",
        properties: { context_length: 1050000, max_output_tokens: 128000 },
      },
    ],
  };
  await upsertViaSettings("model-providers", manifest, "model provider: openai");
}

async function upsertMcpServers() {
  for (const { name, url, description } of MCP_SERVERS) {
    const manifest = { type: "remote", name, url, description };
    await upsertViaSettings("mcp-servers", manifest, `MCP server: ${name} -> ${url}`);
  }
}

async function upsertSkills() {
  if (!SKILL_REPO_URL) {
    console.warn(
      "⚠ Skipping skill registration: set PHARMAFLOW_SKILL_REPO_URL to this repo's GitHub URL " +
        "(e.g. https://github.com/<you>/pharmaflow) once it's pushed, then re-run `npm run setup`."
    );
    return false;
  }
  for (const { name, path: skillPath, description } of SKILLS) {
    const manifest = { type: "git", name, url: SKILL_REPO_URL, path: skillPath, ref: SKILL_REPO_REF, description };
    await upsertViaSettings("skills", manifest, `skill: ${name}`);
  }
  return true;
}

async function upsertAgent(skillsRegistered) {
  const manifest = {
    model: { name: MODEL_NAME },
    instructions: AGENT_INSTRUCTIONS,
    mcp_servers: AGENT_MCP_SERVERS,
    ...(skillsRegistered ? { skills: SKILLS.map(({ name }) => ({ name })) } : {}),
  };
  const { data: existing } = await call("GET", "/api/v1/agents");
  const found = existing.find((a) => a.name === AGENT_NAME);
  if (found) {
    await call("PUT", `/api/v1/agents/${found.id}`, { manifest });
    console.log(`✓ updated agent: ${AGENT_NAME}`);
  } else {
    await call("POST", "/api/v1/agents", { name: AGENT_NAME, manifest });
    console.log(`✓ created agent: ${AGENT_NAME}`);
  }
}

async function main() {
  console.log(`Configuring TrueForge at ${BASE_URL} ...`);
  await upsertModelProvider();
  await upsertMcpServers();
  const skillsRegistered = await upsertSkills();
  await upsertAgent(skillsRegistered);
  console.log("\nDone. Open the TrueForge chat UI or run `npm run backend` and visit http://localhost:8787.");
  if (OPENAI_API_KEY.startsWith("sk-placeholder")) {
    console.log("\n⚠ Reminder: OPENAI_API_KEY is still a placeholder — set a real key in .env and re-run `npm run setup`.");
  }
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
