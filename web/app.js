// PharmaFlow dashboard — vanilla JS, no framework/build step.

const state = {
  patients: [],
  activePatientId: null,
  activeCaseId: null,
  cases: [],
  refillAlerts: [],
  interactionAlerts: [],
  supplyRiskAlerts: [],
  conversationId: localStorage.getItem("pharmaflow-conversation-id") ?? crypto.randomUUID(),
};
localStorage.setItem("pharmaflow-conversation-id", state.conversationId);

const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

/** Reads a Server-Sent Events response, dispatching each event to a handler by name. */
async function consumeSSE(response, handlers) {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const eventMatch = chunk.match(/^event: (.+)$/m);
      const dataMatch = chunk.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;
      handlers[eventMatch[1]]?.(JSON.parse(dataMatch[1]));
    }
  }
}

function formatRelativeTime(iso) {
  if (!iso) return "Not yet checked";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function refillStatusLabel(status) {
  return { overdue: "Overdue", critical: "Due today/tomorrow", "due-soon": "Due soon", ok: "On track" }[status] ?? status;
}
function refillPillClass(status) {
  if (status === "overdue" || status === "critical") return "pill-danger";
  if (status === "due-soon") return "pill-warn";
  return "pill-ok";
}
function refillDotClass(status) {
  if (status === "overdue" || status === "critical") return "dot-critical";
  if (status === "due-soon") return "dot-warn";
  return "dot-ok";
}

// ---- Agent status strip (Patient Panel): real, never a placeholder ----

async function loadAgentStatus() {
  try {
    const status = await fetchJSON("/api/agent-status");
    el("status-fda").textContent = formatRelativeTime(status.lastChecked.fda);
    el("status-prescriptions").textContent = formatRelativeTime(status.lastChecked.prescriptions);
    el("status-attention").textContent = status.casesRequiringAttention
      ? `${status.casesRequiringAttention} case${status.casesRequiringAttention === 1 ? "" : "s"} require attention`
      : "No cases currently require attention.";
  } catch (err) {
    el("status-attention").innerHTML = `<span class="error-note">${escapeHtml(err.message)}</span>`;
  }
}

// ---- Sidebar: patient list, with real per-patient concern counts ----

function patientConcernSummary(patientId) {
  const counts = [
    [state.refillAlerts.filter((a) => a.patientId === patientId).length, "refill"],
    [state.interactionAlerts.filter((a) => a.patientId === patientId).length, "interaction"],
    [state.supplyRiskAlerts.filter((a) => a.patientId === patientId).length, "supply risk"],
  ];
  const parts = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return parts.length ? parts.join(" · ") : "No active concerns";
}

async function loadPatientList() {
  try {
    state.patients = await fetchJSON("/api/patients");
    renderPatientList();
  } catch (err) {
    el("patient-list").innerHTML = `<p class="error-note">Couldn't load patients: ${escapeHtml(err.message)}</p>`;
  }
}

function renderPatientList() {
  const container = el("patient-list");
  if (!state.patients.length) {
    container.innerHTML = `<p class="muted small">No patients on file.</p>`;
    return;
  }
  container.innerHTML = state.patients
    .map(
      (p) => `
      <button class="patient-row ${p.id === state.activePatientId ? "active" : ""}" data-id="${p.id}">
        <span class="dot ${refillDotClass(p.worstRefillStatus)}"></span>
        <span class="patient-row-info">
          <div class="patient-row-name">${escapeHtml(p.name)}</div>
          <div class="patient-row-meta">${p.age} &middot; ${p.medicationCount} medications</div>
          <div class="patient-row-concerns">${escapeHtml(patientConcernSummary(p.id))}</div>
        </span>
      </button>`
    )
    .join("");
  container.querySelectorAll(".patient-row").forEach((row) => {
    row.addEventListener("click", () => openPatient(row.dataset.id));
  });
}

// ---- Overview: refill + interaction + supply-risk alerts ----

async function loadOverviewAlerts() {
  try {
    state.refillAlerts = await fetchJSON("/api/refill-alerts?days=14");
    el("refill-alerts").innerHTML = state.refillAlerts.length
      ? state.refillAlerts
          .map(
            (a) => `
        <div class="alert-row">
          <span class="alert-row-main">
            <div class="alert-row-title">${escapeHtml(a.medicationName)} &middot; ${escapeHtml(a.patientName)}</div>
            <div class="alert-row-sub">${a.daysUntilDue < 0 ? `${Math.abs(a.daysUntilDue)}d overdue` : `due in ${a.daysUntilDue}d`}</div>
          </span>
          <span class="pill ${refillPillClass(a.status)}">${refillStatusLabel(a.status)}</span>
        </div>`
          )
          .join("")
      : `<div class="empty-note"><i class="ph ph-check-circle"></i> No refills due in the next two weeks.</div>`;
  } catch (err) {
    el("refill-alerts").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }

  try {
    state.interactionAlerts = await fetchJSON("/api/interaction-alerts");
    el("interaction-alerts").innerHTML = state.interactionAlerts.length
      ? state.interactionAlerts
          .map(
            (a) => `
        <div class="alert-row">
          <span class="alert-row-main">
            <div class="alert-row-title">${escapeHtml(a.a)} + ${escapeHtml(a.b)} &middot; ${escapeHtml(a.patientName)}</div>
            <div class="alert-row-sub">Potential interaction detected &middot; pharmacist review recommended</div>
          </span>
          <span class="pill ${a.severity === "high" ? "pill-danger" : "pill-warn"}">${a.severity}</span>
        </div>`
          )
          .join("")
      : `<div class="empty-note"><i class="ph ph-check-circle"></i> No known interactions across the panel.</div>`;
  } catch (err) {
    el("interaction-alerts").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }

  try {
    state.supplyRiskAlerts = await fetchJSON("/api/supply-risk");
    el("supply-risk-alerts").innerHTML = state.supplyRiskAlerts.length
      ? state.supplyRiskAlerts
          .map(
            (a) => `
        <div class="alert-row">
          <span class="alert-row-main">
            <div class="alert-row-title">${escapeHtml(a.medicationName)} &middot; ${escapeHtml(a.patientName)}</div>
            <div class="alert-row-sub">${escapeHtml(a.status)} &middot; ${a.source === "fda_live" ? "live FDA data" : "demo data"}</div>
          </span>
          <span class="pill ${a.source === "fda_live" ? "pill-danger" : "pill-warn"}">${a.source === "fda_live" ? "FDA" : "demo"}</span>
        </div>`
          )
          .join("")
      : `<div class="empty-note"><i class="ph ph-check-circle"></i> No active FDA shortages match this panel's medications.</div>`;
  } catch (err) {
    el("supply-risk-alerts").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }

  renderPatientList(); // now that alert data is in, refresh sidebar concern counts
}

// ---- Patient detail ----

async function openPatient(id) {
  state.activePatientId = id;
  renderPatientList();
  el("alerts-section").classList.add("hidden");
  el("agent-status-strip").classList.add("hidden");
  const detail = el("patient-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = `<div class="skeleton-row"></div>`;

  try {
    const patient = await fetchJSON(`/api/patients/${id}`);
    el("view-title").textContent = patient.name;
    el("view-subtitle").textContent = `${patient.age} years old · ${patient.conditions.join(", ")}`;
    detail.innerHTML = renderPatientDetail(patient);
    detail.querySelectorAll("[data-log]").forEach((btn) => {
      btn.addEventListener("click", () => logDose(patient.id, btn.dataset.med, btn.dataset.log === "taken"));
    });
  } catch (err) {
    detail.innerHTML = `<p class="error-note">Couldn't load patient: ${escapeHtml(err.message)}</p>`;
  }
}

function backToOverview() {
  state.activePatientId = null;
  renderPatientList();
  el("patient-detail").classList.add("hidden");
  el("alerts-section").classList.remove("hidden");
  el("agent-status-strip").classList.remove("hidden");
  el("view-title").textContent = "Medication Continuity Command Center";
  el("view-subtitle").textContent = "PharmaFlow is monitoring medication supply, refill, and safety signals across the patient panel.";
}

function renderPatientDetail(patient) {
  const interactions = patient.interactions
    .map(
      (i) => `
      <div class="interaction-banner">
        <i class="ph ph-warning"></i>
        <div>
          <strong>${escapeHtml(i.a)} + ${escapeHtml(i.b)}</strong>
          <div class="interaction-banner-label">Potential interaction detected</div>
          <div class="interaction-banner-row"><span>Why it matters</span><span>${escapeHtml(i.note)}</span></div>
          <div class="interaction-banner-row"><span>Next step</span><span>Pharmacist review recommended</span></div>
        </div>
        <span class="pill ${i.severity === "high" ? "pill-danger" : "pill-warn"}">${i.severity}</span>
      </div>`
    )
    .join("");

  const meds = patient.medications
    .map((m) => {
      const pct = m.adherence.adherencePct;
      const showAdherence = !m.adherence.prn && pct !== null;
      return `
      <div class="med-card">
        <div class="med-card-head">
          <div>
            <div class="med-name">${escapeHtml(m.name)}</div>
            <div class="med-dose">${escapeHtml(m.dose)} &middot; ${escapeHtml(m.frequency)}</div>
          </div>
          <span class="pill ${refillPillClass(m.refill.status)}">${refillStatusLabel(m.refill.status)}</span>
        </div>
        <div class="med-meta-row">
          <span>${escapeHtml(m.prescriber)}</span>
          <span>${m.refill.daysUntilDue < 0 ? `${Math.abs(m.refill.daysUntilDue)}d overdue` : `refill in ${m.refill.daysUntilDue}d`}</span>
        </div>
        ${
          showAdherence
            ? `<div class="adherence-track"><div class="adherence-fill ${pct < 80 ? "low" : ""}" style="width:${pct}%"></div></div>
               <div class="med-meta-row"><span>Adherence</span><span>${pct}% (${m.adherence.takenDays}/${m.adherence.loggedDays} days)</span></div>`
            : `<div class="med-meta-row"><span>As-needed medication</span><span></span></div>`
        }
        <div class="med-actions">
          <button class="log-taken" data-log="taken" data-med="${m.id}"><i class="ph ph-check"></i> Taken</button>
          <button class="log-missed" data-log="missed" data-med="${m.id}"><i class="ph ph-x"></i> Missed</button>
        </div>
      </div>`;
    })
    .join("");

  return `
    <div class="patient-detail-head">
      <div>
        <h2>${escapeHtml(patient.name)}</h2>
      </div>
      <button class="icon-btn" id="back-to-overview" aria-label="Back to overview"><i class="ph ph-arrow-left"></i></button>
    </div>
    <div class="condition-tags">${patient.conditions.map((c) => `<span class="condition-tag">${escapeHtml(c)}</span>`).join("")}</div>
    ${interactions}
    <div class="med-grid">${meds}</div>
  `;
}

async function logDose(patientId, medId, taken) {
  try {
    await fetchJSON(`/api/patients/${patientId}/medications/${medId}/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taken }),
    });
    await openPatient(patientId);
    await loadPatientList();
  } catch (err) {
    alert(`Couldn't log dose: ${err.message}`);
  }
}

// ---- Chat ("Open Agent") ----

function appendChatMessage(kind, html) {
  const wrap = document.createElement("div");
  wrap.className = `chat-msg chat-msg-${kind}`;
  wrap.innerHTML = html;
  el("chat-messages").appendChild(wrap);
  el("chat-messages").scrollTop = el("chat-messages").scrollHeight;
  return wrap;
}

async function sendChatMessage(message) {
  appendChatMessage("user", escapeHtml(message));
  const agentBubble = appendChatMessage("agent", "");
  const toolNotes = new Map();
  let text = "";
  const sendBtn = el("chat-form").querySelector("button");
  sendBtn.disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId: state.conversationId }),
    });
    await consumeSSE(res, {
      delta: (data) => {
        if (!data.text) return;
        text += data.text;
        agentBubble.textContent = text;
      },
      tool_call: (data) => {
        if (data.name && !toolNotes.has(data.id)) {
          toolNotes.set(data.id, appendChatMessage("tool", `<i class="ph ph-wrench"></i> Calling <code>${escapeHtml(data.name)}</code>`));
        }
      },
      approval_required: (data) => {
        appendChatMessage(
          "approval",
          `<i class="ph-fill ph-lock-key"></i> Human approval required for case <strong>${escapeHtml(data.caseId)}</strong>.
           <button class="link-btn" data-goto-case="${escapeHtml(data.caseId)}">Respond in Mission Control</button>`
        );
      },
      error: (data) => appendChatMessage("error", escapeHtml(data.message || "Something went wrong.")),
    });
    if (!text) agentBubble.remove();
  } catch (err) {
    appendChatMessage("error", `Connection error: ${escapeHtml(err.message)}`);
  } finally {
    sendBtn.disabled = false;
  }
}

// ---- Mission Control: real agent activity, polled while the tab is visible ----

let missionControlPollTimer = null;

function eventIcon(type) {
  return {
    session: "ph-plug",
    tool_call: "ph-wrench",
    tool_result: "ph-check",
    approval_required: "ph-lock-key",
    case_update: "ph-clipboard-text",
    turn_done: "ph-flag-checkered",
  }[type] ?? "ph-dot";
}

function caseStatusLabel(status) {
  return { detected: "Detected", approval_required: "Approval required", resolved: "Resolved" }[status] ?? status;
}
function caseStatusPillClass(status) {
  if (status === "approval_required") return "pill-danger";
  if (status === "resolved") return "pill-ok";
  return "pill-warn";
}

async function loadCases() {
  try {
    state.cases = await fetchJSON("/api/cases");
    el("stat-open-cases").textContent = state.cases.filter((c) => c.status !== "resolved").length;
    el("stat-approval-required").textContent = state.cases.filter((c) => c.status === "approval_required").length;
    renderCaseList();
  } catch (err) {
    el("case-list").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
}

function renderCaseList() {
  const container = el("case-list");
  if (!state.cases.length) {
    container.innerHTML = `<div class="empty-note"><i class="ph ph-check-circle"></i> No medication continuity cases open right now.</div>`;
    return;
  }
  container.innerHTML = state.cases
    .map(
      (c) => `
      <button class="case-row ${c.id === state.activeCaseId ? "active" : ""}" data-case="${c.id}">
        <span class="case-row-main">
          <div class="case-row-title">${escapeHtml(c.id)} &middot; ${escapeHtml(c.medicationName)} &middot; ${escapeHtml(c.patientName)}</div>
          <div class="case-row-sub">${escapeHtml(c.triggerSummary)}</div>
        </span>
        <span class="pill ${caseStatusPillClass(c.status)}">${caseStatusLabel(c.status)}</span>
      </button>`
    )
    .join("");
  container.querySelectorAll(".case-row").forEach((row) => {
    row.addEventListener("click", () => openCase(row.dataset.case));
  });
}

function renderCaseEvidence(kase) {
  if (kase.triggerType === "supply_risk") {
    return `
      <div class="evidence-row"><span>Source</span><span>${kase.evidence.source === "fda_live" ? "Live FDA data" : "Demo fixture"}</span></div>
      <div class="evidence-row"><span>FDA status</span><span>${escapeHtml(kase.evidence.status)}</span></div>
      ${kase.evidence.updateDate ? `<div class="evidence-row"><span>Updated</span><span>${escapeHtml(kase.evidence.updateDate)}</span></div>` : ""}
    `;
  }
  return `
    <div class="evidence-row"><span>Source</span><span>Synthetic interaction table</span></div>
    <div class="evidence-row"><span>Why it matters</span><span>${escapeHtml(kase.evidence.note)}</span></div>
  `;
}

function renderApprovalPanel(kase) {
  return `
    <div class="approval-panel">
      <div class="approval-panel-head"><i class="ph-fill ph-lock-key"></i> Human approval required</div>
      <p>PharmaFlow wants to create a pharmacist review for this case. It will not proceed without a decision.</p>
      <div class="approval-actions">
        <button class="approve-btn" data-approve="${kase.id}"><i class="ph ph-check"></i> Approve</button>
        <button class="reject-btn" data-reject="${kase.id}"><i class="ph ph-x"></i> Reject</button>
      </div>
    </div>`;
}

function renderPharmacistReview(kase) {
  const review = kase.pharmacistReview;
  const label = { approved: "Approved", denied: "Denied", "auto-resolved": "Auto-resolved" }[review.decision] ?? review.decision;
  return `
    <div class="review-note">
      <h3>Pharmacist review</h3>
      <div class="evidence-row"><span>Decision</span><span>${escapeHtml(label)}</span></div>
      ${review.note ? `<div class="evidence-row"><span>Note</span><span>${escapeHtml(review.note)}</span></div>` : ""}
    </div>`;
}

function renderCaseDetail(kase) {
  return `
    <div class="patient-detail-head">
      <div>
        <div class="case-detail-id">${escapeHtml(kase.id)}</div>
        <h2>${escapeHtml(kase.medicationName)} &middot; ${escapeHtml(kase.patientName)}</h2>
      </div>
      <button class="icon-btn" id="close-case-detail" aria-label="Close case"><i class="ph ph-x"></i></button>
    </div>
    <div class="case-meta-row">
      <span class="pill pill-danger">${escapeHtml(kase.priority)} priority</span>
      <span class="pill ${caseStatusPillClass(kase.status)}">${caseStatusLabel(kase.status)}</span>
    </div>
    <div class="case-evidence">
      <h3>Evidence</h3>
      ${renderCaseEvidence(kase)}
    </div>
    ${kase.status === "approval_required" ? renderApprovalPanel(kase) : ""}
    ${kase.pharmacistReview ? renderPharmacistReview(kase) : ""}
  `;
}

async function openCase(caseId) {
  state.activeCaseId = caseId;
  renderCaseList();
  const detail = el("case-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = `<div class="skeleton-row"></div>`;
  try {
    const kase = await fetchJSON(`/api/cases/${caseId}`);
    detail.innerHTML = renderCaseDetail(kase);
  } catch (err) {
    detail.innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
}

function closeCaseDetail() {
  state.activeCaseId = null;
  el("case-detail").classList.add("hidden");
  renderCaseList();
}

async function respondToApproval(caseId, decision) {
  const detail = el("case-detail");
  detail.innerHTML = `<div class="skeleton-row"></div><p class="muted small">Submitting ${decision === "allow" ? "approval" : "rejection"}...</p>`;
  try {
    const res = await fetch("/api/chat/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId, decision }),
    });
    await consumeSSE(res, {}); // side effects (case resolution) matter here, not the transcript
    await loadCases();
    await openCase(caseId);
    loadAgentStatus();
  } catch (err) {
    alert(`Couldn't submit decision: ${err.message}`);
    await openCase(caseId);
  }
}

async function loadEventFeed() {
  try {
    const events = await fetchJSON("/api/events?limit=30");
    el("event-feed").innerHTML = events.length
      ? events
          .map(
            (e) => `
        <div class="event-row">
          <i class="ph ${eventIcon(e.type)}"></i>
          <span class="event-label">${escapeHtml(e.label)}</span>
          <span class="event-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
        </div>`
          )
          .join("")
      : `<p class="empty-note"><i class="ph ph-moon-stars"></i> No agent activity yet. Open the agent and ask something.</p>`;
  } catch (err) {
    el("event-feed").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
}

async function loadToolCallStat() {
  try {
    const stats = await fetchJSON("/api/mission-control/stats");
    el("stat-tool-calls").textContent = stats.toolCallsThisSession;
  } catch {
    // Keeps its last known value if this poll fails.
  }
}

function refreshMissionControl() {
  loadCases();
  loadToolCallStat();
  loadEventFeed();
}

function startMissionControlPolling() {
  refreshMissionControl();
  missionControlPollTimer = setInterval(refreshMissionControl, 4000);
}

function stopMissionControlPolling() {
  clearInterval(missionControlPollTimer);
  missionControlPollTimer = null;
}

function switchView(viewName) {
  document.querySelectorAll(".view-tab").forEach((tab) => {
    const active = tab.dataset.view === viewName;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  el("view-patient-panel").classList.toggle("hidden", viewName !== "patient-panel");
  el("view-mission-control").classList.toggle("hidden", viewName !== "mission-control");

  if (viewName === "mission-control") startMissionControlPolling();
  else stopMissionControlPolling();
}

document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

// ---- Wiring ----

el("chat-toggle").addEventListener("click", () => el("chat-panel").classList.remove("hidden"));
el("chat-close").addEventListener("click", () => el("chat-panel").classList.add("hidden"));
el("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el("chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  sendChatMessage(message);
});

document.addEventListener("click", (e) => {
  if (e.target.closest("#back-to-overview")) return backToOverview();
  if (e.target.closest("#close-case-detail")) return closeCaseDetail();

  const gotoCase = e.target.closest("[data-goto-case]");
  if (gotoCase) {
    switchView("mission-control");
    return openCase(gotoCase.dataset.gotoCase);
  }

  const approveBtn = e.target.closest("[data-approve]");
  if (approveBtn) return respondToApproval(approveBtn.dataset.approve, "allow");

  const rejectBtn = e.target.closest("[data-reject]");
  if (rejectBtn) return respondToApproval(rejectBtn.dataset.reject, "deny");
});

loadPatientList();
loadOverviewAlerts();
loadAgentStatus();
setInterval(loadAgentStatus, 5000);
