// FDA MCP tool server.
//
// Wraps openFDA drug-shortage data as MCP tools, kept separate from
// pharmacy-tools (src/mcp-server.mjs) so each MCP server has one clear
// domain: this one only ever talks to FDA data, it never decides what the
// pharmacy should do about it (that's the agent + skill's job).

import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as fda from "./fda.mjs";

const PORT = process.env.FDA_MCP_PORT || 8792;

function buildServer() {
  const server = new McpServer({ name: "fda-shortages", version: "0.1.0" });

  server.registerTool(
    "search_drug_shortages",
    {
      title: "Search drug shortages",
      description:
        "Search current openFDA shortage records for a drug name. Falls back to a clearly labeled demo fixture if the live API is unreachable. Every record's `source` field says whether it's 'fda_live' or 'demo' - always report which.",
      inputSchema: { drugName: z.string().describe("Generic or brand drug name, e.g. 'Warfarin'") },
    },
    async ({ drugName }) => ({
      content: [{ type: "text", text: JSON.stringify(await fda.searchDrugShortages(drugName), null, 2) }],
    })
  );

  server.registerTool(
    "get_recent_shortage_updates",
    {
      title: "Get recent shortage updates",
      description:
        "List the most recently updated active FDA shortage records, regardless of drug name. Useful for 'what changed recently' style questions. Falls back to a labeled demo fixture if the live API is unreachable.",
      inputSchema: { limit: z.number().int().min(1).max(20).default(5).describe("Max records to return") },
    },
    async ({ limit }) => ({
      content: [{ type: "text", text: JSON.stringify(await fda.getRecentShortageUpdates(limit ?? 5), null, 2) }],
    })
  );

  return server;
}

const app = express();
app.use(express.json());

app.all("/mcp", async (req, res) => {
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.type("text/plain").send("PharmaFlow FDA MCP server active on /mcp (Streamable HTTP transport)");
  }
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
    console.error("FDA MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "pharmaflow-fda-mcp-server" }));

app.listen(PORT, () => {
  console.log(`PharmaFlow FDA MCP server listening on http://localhost:${PORT}/mcp`);
});
