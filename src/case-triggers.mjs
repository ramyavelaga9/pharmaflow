// Converts already-computed, real alert data (from store.mjs / fda.mjs) into
// case triggers. Pure and side-effect free on purpose: it never fetches
// anything itself, so it's trivially testable with hand-built alert arrays
// and can't accidentally invent a case from data that was never checked.
//
// Scoped deliberately narrow: every supply-risk hit is case-worthy (an
// active FDA signal touching a real patient), but only high-severity
// interactions are — a moderate interaction is useful context on the
// Patient Panel, not yet a case PharmaFlow should be tracking a lifecycle
// for.

function triggerFromSupplyRisk(alert) {
  return {
    type: "supply_risk",
    patientId: alert.patientId,
    patientName: alert.patientName,
    medicationName: alert.medicationName,
    priority: "high",
    summary: `FDA shortage: ${alert.status}`,
    evidence: { source: alert.source, status: alert.status, updateDate: alert.updateDate },
  };
}

function triggerFromInteraction(alert) {
  return {
    type: "interaction_risk",
    patientId: alert.patientId,
    patientName: alert.patientName,
    medicationName: `${alert.a} + ${alert.b}`,
    priority: "high",
    summary: `Potential interaction: ${alert.a} + ${alert.b}`,
    evidence: { source: "synthetic_interaction_table", note: alert.note, severity: alert.severity },
  };
}

function triggersFromAlerts(supplyRiskAlerts, interactionAlerts) {
  return [
    ...supplyRiskAlerts.map(triggerFromSupplyRisk),
    ...interactionAlerts.filter((a) => a.severity === "high").map(triggerFromInteraction),
  ];
}

export { triggersFromAlerts };
