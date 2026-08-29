// One-shot setup script: registers PharmaFlow's model provider, MCP server,
// skill, and agent on a locally running TrueForge instance via its REST API,
// so the whole harness config is code (reviewable, reproducible) instead of
// manual clicking through Settings.
//
// Prereqs:
//   1. TrueForge running locally: `npx @truefoundry/trueforge@latest`
//   2. The PharmaFlow MCP server running: `npm run mcp`
//   3. OPENAI_API_KEY set in .env (a placeholder key still lets you register
//      everything and wire it up — the agent just won't answer for real
//      until you swap in a working key and re-run this script)
//
// Safe to re-run: existing resources are updated in place rather than
// duplicated.

import "dotenv/config";

const BASE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const MCP_URL = process.env.PHARMAFLOW_MCP_URL || "http://localhost:8791/mcp";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-placeholder-replace-me";
const SKILL_REPO_URL = process.env.PHARMAFLOW_SKILL_REPO_URL || "";
const SKILL_REPO_REF = process.env.PHARMAFLOW_SKILL_REPO_REF || "main";

const MODEL_NAME = "openai/gpt-5-5";
const AGENT_NAME = "pharmaflow";
const MCP_SERVER_NAME = "pharmaflow-tools";
const SKILL_NAME = "medication-continuity";

const AGENT_INSTRUCTIONS = `You are PharmaFlow, a medication continuity assistant for a care
coordination team. You help staff spot refill gaps, drug interaction risk,
and adherence problems across a patient panel before they become crises.

Always ground answers in the pharmaflow-tools MCP tools and the
medication-continuity skill — never invent patient data. If a question is
ambiguous about which patient is meant, ask before guessing.`;

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
  try {
    await call("POST", "/api/v1/settings/model-providers", { manifest });
    console.log("✓ registered model provider: openai");
  } catch (err) {
    if (/exists/i.test(err.message)) {
      await call("PUT", "/api/v1/settings/model-providers", { manifest });
      console.log("✓ updated model provider: openai");
    } else {
      throw err;
    }
  }
}

async function upsertMcpServer() {
  const manifest = {
    type: "remote",
    name: MCP_SERVER_NAME,
    url: MCP_URL,
    description: "PharmaFlow patient data: refill status, interactions, adherence, dose logging.",
  };
  try {
    await call("POST", "/api/v1/settings/mcp-servers", { manifest });
    console.log(`✓ registered MCP server: ${MCP_SERVER_NAME} -> ${MCP_URL}`);
  } catch (err) {
    if (/exists/i.test(err.message)) {
      await call("PUT", "/api/v1/settings/mcp-servers", { manifest });
      console.log(`✓ updated MCP server: ${MCP_SERVER_NAME} -> ${MCP_URL}`);
    } else {
      throw err;
    }
  }
}

async function upsertSkill() {
  if (!SKILL_REPO_URL) {
    console.warn(
      "⚠ Skipping skill registration: set PHARMAFLOW_SKILL_REPO_URL to this repo's GitHub URL " +
        "(e.g. https://github.com/<you>/pharmaflow) once it's pushed, then re-run `npm run setup`."
    );
    return;
  }
  const manifest = {
    type: "git",
    name: SKILL_NAME,
    url: SKILL_REPO_URL,
    path: "skills/medication-continuity",
    ref: SKILL_REPO_REF,
    description: "Review a patient's regimen for refill gaps, interaction risk, and adherence problems.",
  };
  try {
    await call("POST", "/api/v1/settings/skills", { manifest });
    console.log(`✓ registered skill: ${SKILL_NAME}`);
  } catch (err) {
    if (/exists/i.test(err.message)) {
      await call("PUT", "/api/v1/settings/skills", { manifest });
      console.log(`✓ updated skill: ${SKILL_NAME}`);
    } else {
      throw err;
    }
  }
}

async function upsertAgent(skillRegistered) {
  const manifest = {
    model: { name: MODEL_NAME },
    instructions: AGENT_INSTRUCTIONS,
    mcp_servers: [{ name: MCP_SERVER_NAME }],
    ...(skillRegistered ? { skills: [{ name: SKILL_NAME }] } : {}),
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
  await upsertMcpServer();
  await upsertSkill();
  await upsertAgent(Boolean(SKILL_REPO_URL));
  console.log("\nDone. Open the TrueForge chat UI or run `npm run backend` and visit http://localhost:8787.");
  if (OPENAI_API_KEY.startsWith("sk-placeholder")) {
    console.log("\n⚠ Reminder: OPENAI_API_KEY is still a placeholder — set a real key in .env and re-run `npm run setup`.");
  }
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
