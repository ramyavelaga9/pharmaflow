// Small, pure helpers for describing real tool-call telemetry in the
// Mission Control activity feed: which MCP server a tool belongs to, and a
// short, honest summary of what a tool actually returned. Never invents a
// count or a status the tool didn't report.

const TOOL_SERVERS = {
  list_patients: "pharmaflow-tools",
  get_patient: "pharmaflow-tools",
  get_refill_alerts: "pharmaflow-tools",
  check_interactions: "pharmaflow-tools",
  log_dose: "pharmaflow-tools",
  list_cases: "pharmaflow-tools",
  create_pharmacist_review: "pharmaflow-tools",
  check_pharmacy_inventory: "pharmaflow-tools",
  get_drug_alternatives: "pharmaflow-tools",
  place_refill_order: "pharmaflow-tools",
  propose_alternative_supply: "pharmaflow-tools",
  search_drug_shortages: "fda-shortages",
  get_recent_shortage_updates: "fda-shortages",
  search_drug_recalls: "fda-shortages",
};

function describeToolServer(toolName) {
  if (toolName === "call_tool") return "pharmaflow-tools";
  return TOOL_SERVERS[toolName] ?? "unknown";
}

/** Summarizes a tool's real JSON-text result; falls back to a plain preview for non-JSON content. */
function summarizeToolResult(content) {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return `${parsed.length} record${parsed.length === 1 ? "" : "s"} returned`;
    if (parsed && typeof parsed === "object") return "1 record returned";
  } catch {
    // Not JSON - fall through to a plain text preview.
  }
  const text = String(content ?? "").trim();
  if (!text) return "No result content";
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

export { describeToolServer, summarizeToolResult, TOOL_SERVERS };
