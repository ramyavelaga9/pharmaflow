// Tracks when each real data source was last actually checked, for the
// Patient Panel's status strip. A factory (not a module-level singleton)
// keeps this independently testable, the same pattern as event-log.mjs.
//
// Deliberately not persisted or backdated: "last checked" must reflect
// this server process's real activity since it started, never a
// hardcoded placeholder like "32s ago".

const CHECK_SOURCES = ["fda", "prescriptions"];

function createAgentStatus() {
  const lastChecked = Object.fromEntries(CHECK_SOURCES.map((source) => [source, null]));

  function recordCheck(source) {
    if (!CHECK_SOURCES.includes(source)) throw new Error(`Unknown check source: ${source}`);
    lastChecked[source] = new Date().toISOString();
  }

  function getStatus() {
    return { active: true, lastChecked: { ...lastChecked } };
  }

  return { recordCheck, getStatus };
}

export { createAgentStatus, CHECK_SOURCES };
