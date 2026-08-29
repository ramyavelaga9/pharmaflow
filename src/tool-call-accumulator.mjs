// Accumulates OpenAI-style streamed tool-call deltas into complete calls.
//
// The provider streams a tool call's name/arguments in fragments, keyed by
// a stream index (0, 1, 2, ...) - but that index is only unique within one
// round of tool calls. A turn with several rounds (call a tool, get the
// result, call another) restarts indices from 0 each round. Naively
// accumulating by index alone means a later round's index-0 call silently
// concatenates onto an earlier, already-finished index-0 call's name and
// arguments - producing a corrupted, misleading name like
// "list_toolsget_tool_info". complete() must be called once a call's real
// result has arrived, freeing its index for safe reuse by a later round.
//
// A call's `id` is stable from creation even though the real provider id
// often only appears on a call's first delta: without that, id-less
// follow-up deltas would each report a different fallback id, splitting
// one real call into what looks like several to anything downstream.

function createToolCallAccumulator() {
  const byIndex = new Map();
  const byId = new Map();

  function applyDelta(tc) {
    const idx = tc.index ?? 0;
    let call = byIndex.get(idx);
    if (!call) {
      call = { id: tc.id ?? `idx-${idx}`, name: "", args: "" };
      byIndex.set(idx, call);
    }
    if (tc.id) {
      call.id = tc.id;
      byId.set(tc.id, call);
    }
    if (tc.function?.name) call.name += tc.function.name;
    if (tc.function?.arguments) call.args += tc.function.arguments;
    return call;
  }

  function getById(id) {
    return byId.get(id);
  }

  /** Forgets a completed call so a later round can safely reuse its stream index. */
  function complete(id) {
    const call = byId.get(id);
    if (!call) return;
    for (const [idx, value] of byIndex) {
      if (value === call) byIndex.delete(idx);
    }
    byId.delete(id);
  }

  return { applyDelta, getById, complete };
}

/**
 * TrueForge routes a model's tool invocation one of two ways: directly
 * (the call's name IS the real tool name), or - when a server exposes many
 * tools via progressive disclosure, the same pattern this very harness
 * uses for its own deferred tools - through TrueForge's own `call_tool`
 * meta-tool: {mcp_server, tool_name, input}. Code that needs to know which
 * real tool is being invoked (e.g. spotting a create_pharmacist_review
 * call to wire up case approval) has to check both shapes, or it silently
 * misses every call made through the wrapped form. Returns null if a
 * wrapped call has no parseable tool_name, rather than throwing.
 */
function resolveActualToolCall(call) {
  if (!call) return null;
  if (call.name !== "call_tool") return { name: call.name, args: call.args };
  try {
    const parsed = JSON.parse(call.args || "{}");
    if (!parsed.tool_name) return null;
    return { name: parsed.tool_name, args: JSON.stringify(parsed.input ?? {}) };
  } catch {
    return null;
  }
}

export { createToolCallAccumulator, resolveActualToolCall };
