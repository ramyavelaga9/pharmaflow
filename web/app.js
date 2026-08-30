// PharmaFlow dashboard — vanilla JS, no framework/build step.

const state = {
  patients: [],
  activePatientId: null,
  // Bumped on every openPatient() call, including repeat calls for the same
  // patient — an id match alone can't distinguish an older in-flight
  // request from the latest one when both target the same patient.
  patientRequestToken: 0,
  activeCaseId: null,
  cases: [],
  drugs: [],
  refillAlerts: [],
  interactionAlerts: [],
  supplyRiskAlerts: [],
  missionStats: null,
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

function setCheckedIcon(iconId, checked) {
  el(iconId).className = checked ? "ph ph-check-circle" : "ph ph-circle-dashed";
}

async function loadAgentStatus() {
  try {
    const status = await fetchJSON("/api/agent-status");
    el("status-fda").textContent = formatRelativeTime(status.lastChecked.fda);
    el("status-prescriptions").textContent = formatRelativeTime(status.lastChecked.prescriptions);
    const inventoryChecks = state.cases
      .map((c) => c.fulfillment?.lastCheckedAt ?? (c.fulfillment?.stockAtOrder != null ? c.updatedAt : null))
      .filter(Boolean)
      .sort();
    el("status-inventory").textContent = formatRelativeTime(inventoryChecks.at(-1));
    setCheckedIcon("status-fda-icon", Boolean(status.lastChecked.fda));
    setCheckedIcon("status-prescriptions-icon", Boolean(status.lastChecked.prescriptions));

    // "Last scan" is whichever real check happened most recently - never a
    // separate, independently-fabricated timestamp.
    const timestamps = [status.lastChecked.fda, status.lastChecked.prescriptions].filter(Boolean);
    const mostRecent = timestamps.length ? timestamps.sort().at(-1) : null;
    el("status-last-scan").textContent = mostRecent ? formatRelativeTime(mostRecent) : "not yet";

    el("status-attention").textContent = status.casesRequiringAttention
      ? `${status.casesRequiringAttention} case${status.casesRequiringAttention === 1 ? "" : "s"} require attention`
      : "No cases currently require attention.";
  } catch (err) {
    el("status-attention").innerHTML = `<span class="error-note">${escapeHtml(err.message)}</span>`;
  }
}

// ---- Sidebar: patient list, with real per-patient concern counts ----

/** Renders each real concern count as a small colored tag, not a plain-text line. */
function patientConcernSummary(patientId) {
  const counts = [
    [state.refillAlerts.filter((a) => a.patientId === patientId).length, "refill", "pill-danger"],
    [state.interactionAlerts.filter((a) => a.patientId === patientId).length, "interaction", "pill-warn"],
    [state.supplyRiskAlerts.filter((a) => a.patientId === patientId).length, "supply risk", "pill-danger"],
  ];
  const tags = counts
    .filter(([count]) => count > 0)
    .map(([count, label, tone]) => `<span class="pill ${tone} pill-xs">${count} ${escapeHtml(label)}</span>`)
    .join("");
  return tags || `<span class="pill pill-ok pill-xs">No active concerns</span>`;
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
          <div class="patient-row-concerns">${patientConcernSummary(p.id)}</div>
        </span>
      </button>`
    )
    .join("");
  container.querySelectorAll(".patient-row").forEach((row) => {
    row.addEventListener("click", () => openPatient(row.dataset.id));
  });
}

// ---- Overview: refill + interaction + supply-risk alerts ----

/** An alert row that has a real backing case opens it; otherwise it's informational only (never a dead-looking click target). */
function alertRowTag(kase) {
  return kase ? "button" : "div";
}
function alertRowAttrs(kase) {
  return kase ? `class="alert-row alert-row-clickable" data-goto-case="${escapeHtml(kase.id)}"` : `class="alert-row"`;
}

async function loadOverviewAlerts() {
  try {
    state.refillAlerts = await fetchJSON("/api/refill-alerts?days=14");
    el("refill-alerts").innerHTML = state.refillAlerts.length
      ? state.refillAlerts
        .map((a) => {
          const urgent = a.status === "overdue" || a.status === "critical";
          return `
        <div class="alert-row">
          <span class="alert-row-main">
            <div class="alert-row-title">${escapeHtml(a.medicationName)} &middot; ${escapeHtml(a.patientName)}</div>
            <div class="alert-row-sub">${a.daysUntilDue < 0 ? `${Math.abs(a.daysUntilDue)}d overdue` : `due in ${a.daysUntilDue}d`}</div>
          </span>
          <span class="alert-row-pills">
            <span class="pill ${refillPillClass(a.status)}">${refillStatusLabel(a.status)}</span>
            ${urgent ? `<span class="pill pill-muted">Review recommended</span>` : ""}
          </span>
        </div>`;
        })
        .join("")
      : `<div class="empty-note"><i class="ph ph-check-circle"></i> No refills due in the next two weeks.</div>`;
  } catch (err) {
    el("refill-alerts").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }

  try {
    state.interactionAlerts = await fetchJSON("/api/interaction-alerts");
    el("interaction-alerts").innerHTML = state.interactionAlerts.length
      ? state.interactionAlerts
        .map((a) => {
          // Only high-severity interactions become real cases (case-triggers.mjs) - a
          // moderate one has nothing to open, so it stays a plain informational row.
          const kase = a.severity === "high" ? findCaseForAlert(a.patientId, `${a.a} + ${a.b}`) : null;
          const tag = alertRowTag(kase);
          return `
        <${tag} ${alertRowAttrs(kase)}>
          <span class="alert-row-main">
            <div class="alert-row-title">${escapeHtml(a.a)} + ${escapeHtml(a.b)} &middot; ${escapeHtml(a.patientName)}</div>
            <div class="alert-row-sub">Potential interaction detected &middot; pharmacist review recommended</div>
          </span>
          <span class="pill ${kase ? caseStatusPillClass(kase.status) : a.severity === "high" ? "pill-danger" : "pill-warn"}">${kase ? caseStatusLabel(kase.status) : a.severity}</span>
        </${tag}>`;
        })
        .join("")
      : `<div class="empty-note"><i class="ph ph-check-circle"></i> No known interactions across the panel.</div>`;
  } catch (err) {
    el("interaction-alerts").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }

  try {
    // Still fetched for the sidebar's real per-patient concern counts, even
    // though the old summary banner is gone - the live Supply Fulfillment
    // section (renderFulfillmentList, driven by real case data) replaced it.
    state.supplyRiskAlerts = await fetchJSON("/api/supply-risk");
  } catch {
    // The Supply Fulfillment section surfaces its own real errors; this
    // fetch only feeds sidebar counts, so a failure here degrades quietly.
  }

  renderPatientList(); // now that alert data is in, refresh sidebar concern counts
}

// ---- Patient detail ----

async function openPatient(id) {
  state.activePatientId = id;
  // A patient-id match alone can't tell two in-flight requests for the SAME
  // patient apart (e.g. a rapid double-click, or A -> overview -> A), so an
  // older response could still overwrite a newer one. A token unique to
  // *this* call can.
  const requestToken = ++state.patientRequestToken;
  renderPatientList();
  el("alerts-section").classList.add("hidden");
  const detail = el("patient-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = `<div class="skeleton-row"></div>`;

  try {
    const patient = await fetchJSON(`/api/patients/${id}`);
    // Render only if this call is still the most recent one for the active
    // patient — a newer selection, a repeat selection, or a return to
    // overview may have happened while this fetch was in flight.
    if (state.activePatientId !== id || state.patientRequestToken !== requestToken) return;
    el("view-title").textContent = patient.name;
    el("view-subtitle").textContent = `${patient.age} years old · ${patient.conditions.join(", ")}`;
    detail.innerHTML = renderPatientDetail(patient);
    detail.querySelectorAll("[data-log]").forEach((btn) => {
      btn.addEventListener("click", () => logDose(patient.id, btn.dataset.med, btn.dataset.log === "taken"));
    });
  } catch (err) {
    if (state.activePatientId !== id || state.patientRequestToken !== requestToken) return;
    detail.innerHTML = `<p class="error-note">Couldn't load patient: ${escapeHtml(err.message)}</p>`;
  }
}

function backToOverview() {
  state.activePatientId = null;
  renderPatientList();
  el("patient-detail").classList.add("hidden");
  el("alerts-section").classList.remove("hidden");
  el("view-title").textContent = "Patient Panel";
  el("view-subtitle").textContent = "Browse patients and their current refill, interaction, and supply-risk status.";
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
        ${showAdherence
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
let villageLastEvents = [];
let villageSpeed = 1;

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

/** Finds the real case backing an alert, if one exists yet - used to make Patient Panel alerts open their case. */
function findCaseForAlert(patientId, medicationName) {
  return state.cases.find((c) => c.patientId === patientId && c.medicationName === medicationName) ?? null;
}

async function loadCases() {
  try {
    state.cases = await fetchJSON("/api/cases");
    renderCaseList();
    renderAgentVillage();
  } catch (err) {
    if (el("case-list")) el("case-list").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
}

function renderCaseList() {
  const container = el("case-list");
  if (!container) return;
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
    const days = kase.evidence.daysUntilDue;
    const supplyText =
      days == null ? null : days < 0 ? `${Math.abs(days)} days past the patient's own supply` : `${days} days remaining`;
    const stockChecked = kase.fulfillment?.lastCheckedStock ?? kase.fulfillment?.stockAtOrder;
    const inventoryText = stockChecked != null ? `${stockChecked} units (synthetic pharmacy data)` : "Not yet checked";
    return `
      <div class="evidence-row"><span>Source</span><span>${kase.evidence.source === "fda_live" ? "Live FDA data" : "Demo fixture"}</span></div>
      <div class="evidence-row"><span>FDA status</span><span>${escapeHtml(kase.evidence.status)}</span></div>
      ${kase.evidence.updateDate ? `<div class="evidence-row"><span>Updated</span><span>${escapeHtml(kase.evidence.updateDate)}</span></div>` : ""}
      ${supplyText ? `<div class="evidence-row"><span>Patient supply</span><span>${escapeHtml(supplyText)}</span></div>` : ""}
      <div class="evidence-row"><span>Pharmacy inventory</span><span>${escapeHtml(inventoryText)}</span></div>
    `;
  }
  return `
    <div class="evidence-row"><span>Source</span><span>Synthetic interaction table</span></div>
    <div class="evidence-row"><span>Why it matters</span><span>${escapeHtml(kase.evidence.note)}</span></div>
  `;
}

/** A small, honest lifecycle stepper - three real stages, not a preview of the eight-stage pipeline that doesn't exist yet. */
function renderCaseLifecycle(status) {
  const stages = [
    { key: "detected", label: "Detected" },
    { key: "approval_required", label: "Approval required" },
    { key: "resolved", label: "Resolved" },
  ];
  const currentIndex = stages.findIndex((s) => s.key === status);
  return `
    <div class="case-lifecycle">
      ${stages
      .map((s, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "pending";
        const connector = i < stages.length - 1 ? `<span class="lifecycle-connector ${i < currentIndex ? "done" : ""}"></span>` : "";
        return `<div class="lifecycle-step ${state}"><span class="lifecycle-dot"></span><span class="lifecycle-label">${s.label}</span></div>${connector}`;
      })
      .join("")}
    </div>`;
}

function renderApprovalPanel(kase) {
  const altName = kase.pendingApproval?.alternativeDrugName;
  const note = kase.pendingApproval?.note;
  const summary = altName
    ? `PharmaFlow proposes switching <strong>${escapeHtml(kase.patientName)}</strong> from ${escapeHtml(kase.medicationName)} to <strong>${escapeHtml(altName)}</strong>, since ${escapeHtml(kase.medicationName)} is out of stock.`
    : "PharmaFlow wants to create a pharmacist review for this case.";
  return `
    <div class="approval-panel">
      <div class="approval-panel-head"><i class="ph-fill ph-lock-key"></i> Human approval required</div>
      <p>${summary} It will not proceed without a decision.</p>
      ${note ? `<p class="muted small">${escapeHtml(note)}</p>` : ""}
      <div class="approval-actions">
        <button class="approve-btn" data-approve="${kase.id}"><i class="ph ph-check"></i> Approve</button>
        <button class="reject-btn" data-reject="${kase.id}"><i class="ph ph-x"></i> Reject</button>
      </div>
    </div>`;
}

/** Real fulfillment progress: an honest "investigating" note while a real background turn is in flight, or the actual order/notification result once one exists. */
function renderFulfillmentSummary(kase) {
  const f = kase.fulfillment;
  if (!f) return "";
  if (f.method === "auto_reorder") {
    return `
      <div class="review-note">
        <h3>Fulfillment</h3>
        <div class="evidence-row"><span>Action</span><span>Automatic reorder - sufficient stock, no approval needed</span></div>
        <div class="evidence-row"><span>Order</span><span>${escapeHtml(f.orderId)} &middot; ${escapeHtml(f.quantity)}</span></div>
        <div class="evidence-row"><span>Stock at order</span><span>${f.stockAtOrder} units</span></div>
      </div>`;
  }
  if (f.method === "alternative_supply") {
    return `
      <div class="review-note">
        <h3>Fulfillment</h3>
        <div class="evidence-row"><span>Action</span><span>Switched to ${escapeHtml(f.alternativeDrug)} (pharmacist approved)</span></div>
        <div class="evidence-row"><span>Order</span><span>${escapeHtml(f.orderId)}</span></div>
        <div class="evidence-row"><span>Patient notified</span><span>${f.notifiedAt ? new Date(f.notifiedAt).toLocaleString() : "-"}</span></div>
      </div>`;
  }
  if (f.status === "investigating") {
    return `
      <div class="review-note">
        <h3>Fulfillment</h3>
        <div class="evidence-row"><span>Status</span><span>PharmaFlow is checking pharmacy inventory automatically&hellip;</span></div>
      </div>`;
  }
  return "";
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
    ${renderCaseLifecycle(kase.status)}
    <div class="case-evidence">
      <h3>Evidence</h3>
      ${renderCaseEvidence(kase)}
    </div>
    ${kase.status === "approval_required" ? renderApprovalPanel(kase) : ""}
    ${renderFulfillmentSummary(kase)}
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

/** Approve/reject can be triggered from Mission Control's case detail or Patient Panel's fulfillment row - refreshes whichever real UI is showing this case, not just one. */
async function respondToApproval(caseId, decision) {
  const missionShowingThisCase = state.activeCaseId === caseId && !el("case-detail").classList.contains("hidden");
  if (missionShowingThisCase) {
    el("case-detail").innerHTML = `<div class="skeleton-row"></div><p class="muted small">Submitting ${decision === "allow" ? "approval" : "rejection"}...</p>`;
  }
  try {
    const res = await fetch("/api/chat/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId, decision }),
    });
    await consumeSSE(res, {}); // side effects (case resolution) matter here, not the transcript
    await loadCases();
    renderFulfillmentList();
    if (missionShowingThisCase) await openCase(caseId);
    loadAgentStatus();
  } catch (err) {
    alert(`Couldn't submit decision: ${err.message}`);
    if (missionShowingThisCase) await openCase(caseId);
  }
}

// ---- Patient Panel: live supply fulfillment, driven by the same real case data ----

/** Describes a supply-risk case's real current fulfillment state - never a fabricated "processing" animation. */
function describeFulfillmentState(kase) {
  const f = kase.fulfillment;
  if (kase.status === "resolved" && f?.method === "auto_reorder") {
    return { label: "Order placed", tone: "pill-ok", detail: `${escapeHtml(f.drugName)} &middot; ${escapeHtml(f.quantity)} &middot; Order ${escapeHtml(f.orderId)} (${f.stockAtOrder} units were in stock)` };
  }
  if (kase.status === "resolved" && f?.method === "alternative_supply") {
    return { label: "Fulfilled via alternative", tone: "pill-ok", detail: `Switched to <strong>${escapeHtml(f.alternativeDrug)}</strong> &middot; patient notified &middot; order ${escapeHtml(f.orderId)} placed` };
  }
  if (kase.status === "approval_required") {
    return { label: "Approval required", tone: "pill-danger", detail: null };
  }
  if (kase.status === "detected" && kase.pharmacistReview?.decision === "denied") {
    return { label: "Alternative declined", tone: "pill-warn", detail: `Pharmacist declined${kase.pharmacistReview.note ? `: ${escapeHtml(kase.pharmacistReview.note)}` : ""}. No further automatic action.` };
  }
  if (f?.status === "investigating") {
    return { label: "Checking inventory", tone: "pill-warn", detail: "PharmaFlow is automatically checking real pharmacy stock for this medication&hellip;" };
  }
  return { label: "Detected", tone: "pill-warn", detail: "Queued for an automatic inventory check." };
}

function renderFulfillmentRow(kase) {
  const { label, tone, detail } = describeFulfillmentState(kase);
  return `
    <div class="fulfillment-row">
      <div class="case-row-main">
        <div class="case-row-title">${escapeHtml(kase.medicationName)} &middot; ${escapeHtml(kase.patientName)}</div>
        <div class="case-row-sub">${escapeHtml(kase.triggerSummary)}</div>
      </div>
      <span class="pill ${tone}">${label}</span>
    </div>
    ${detail ? `<div class="fulfillment-detail muted small">${detail}</div>` : ""}
    ${kase.status === "approval_required" ? renderApprovalPanel(kase) : ""}
  `;
}

async function loadRecalls() {
  try {
    state.recalls = await fetchJSON("/api/recalls");
  } catch {
    state.recalls = [];
  }
}

async function acknowledgeRecall(recallId, patientId, patientName, medicationName) {
  try {
    await fetchJSON(`/api/recalls/${recallId}/acknowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, patientName, medicationName, note: "Patient recall alert email sent" }),
    });
    await loadRecalls();
    await loadCases();
    renderFulfillmentList();
    loadEventFeed("fulfillment-event-feed");
  } catch (err) {
    alert(`Couldn't acknowledge recall alert: ${err.message}`);
  }
}

function renderFulfillmentList() {
  const approvalContainer = el("human-approval-list");
  const autonomousContainer = el("autonomous-decisions-list");
  if (!approvalContainer || !autonomousContainer) return; // Markup not yet in DOM

  const supplyCases = state.cases.filter((c) => c.triggerType === "supply_risk");

  // --- Left Column: Human Approval & Actions ---
  const recallCardsHtml = (state.recalls || []).map((r) => `
    <div class="fulfillment-card">
      <div class="fulfillment-row">
        <div class="case-row-main">
          <div class="case-row-title">${escapeHtml(r.medicationName)} &middot; ${escapeHtml(r.patientName)}</div>
          <div class="case-row-sub">${escapeHtml(r.recallingFirm)} &middot; ${escapeHtml(r.classification)} Recall</div>
        </div>
        <span class="pill pill-danger">Recall active</span>
      </div>
      <div class="approval-panel">
        <div class="approval-panel-head" style="color: var(--danger);">
          <i class="ph-fill ph-prohibit"></i> Prescription Renewal Blocked
        </div>
        <p style="margin-bottom: 6px;"><strong>Reason:</strong> ${escapeHtml(r.reason)}</p>
        <p style="font-size: 11.5px; color: var(--text-secondary); margin-bottom: 12px;"><strong>Distribution:</strong> ${escapeHtml(r.distributionPattern)}</p>
        <div class="approval-actions">
          <button class="approve-btn" data-acknowledge-recall="${escapeHtml(r.id)}" data-patient-id="${escapeHtml(r.patientId)}" data-patient-name="${escapeHtml(r.patientName)}" data-med-name="${escapeHtml(r.medicationName)}">
            <i class="ph ph-check"></i> Send Recall Alert to Patient &amp; Acknowledge
          </button>
        </div>
      </div>
    </div>
  `).join("");

  const approvalCases = supplyCases.filter((c) => c.status === "approval_required" || (c.status === "detected" && c.fulfillment?.lastCheckedStock === 0));
  const approvalCasesHtml = approvalCases.map((c) => `<div class="fulfillment-card">${renderFulfillmentRow(c)}</div>`).join("");

  const leftColumnHtml = [recallCardsHtml, approvalCasesHtml].filter(Boolean).join("");
  approvalContainer.innerHTML = leftColumnHtml || `<div class="empty-note"><i class="ph ph-check-circle"></i> No pending pharmacist approvals or recall alerts.</div>`;

  // --- Right Column: Autonomous Agent Decisions ---
  const autonomousCases = supplyCases.filter((c) => c.status === "resolved" || (c.status === "detected" && c.fulfillment?.lastCheckedStock > 0) || c.fulfillment?.status === "investigating");
  const rightColumnHtml = autonomousCases.map((c) => `<div class="fulfillment-card">${renderFulfillmentRow(c)}</div>`).join("");
  autonomousContainer.innerHTML = rightColumnHtml || `<div class="empty-note"><i class="ph ph-check-circle"></i> No autonomous decisions recorded yet.</div>`;
}

let patientPanelPollTimer = null;

function refreshPatientPanel() {
  Promise.all([loadCases(), loadRecalls()]).then(renderFulfillmentList);
}

function startPatientPanelPolling() {
  // Idempotent: re-selecting the already-active tab must not stack a second
  // interval on top of the first (each one adding its own duplicate API
  // traffic and DOM updates until the page is reloaded).
  clearInterval(patientPanelPollTimer);
  refreshPatientPanel();
  patientPanelPollTimer = setInterval(refreshPatientPanel, 4000);
}

function stopPatientPanelPolling() {
  clearInterval(patientPanelPollTimer);
  patientPanelPollTimer = null;
}

// ---- Drug Panel: real FDA shortage/recall status per medication, and who it touches ----

let activeDrugName = null;

function formatFdaDate(yyyymmdd) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(yyyymmdd ?? ""));
  if (!match) return null;
  const [, year, month, day] = match;
  return `${month}/${day}/${year}`;
}

async function loadDrugPanel() {
  try {
    state.drugs = await fetchJSON("/api/drugs");
    const withShortage = state.drugs.filter((d) => d.shortage);
    const withRecall = state.drugs.filter((d) => d.recall);
    const affectedPatientIds = new Set(
      [...withShortage, ...withRecall].flatMap((d) => d.patients.map((p) => p.id))
    );
    el("drug-stat-tracked").textContent = state.drugs.length;
    el("drug-stat-shortages").textContent = withShortage.length;
    el("drug-stat-recalls").textContent = withRecall.length;
    el("drug-stat-patients").textContent = affectedPatientIds.size;
    renderDrugList();
    el("drug-panel-updated").textContent = new Date().toLocaleTimeString();
  } catch (err) {
    el("drug-list").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
}

let drugPanelPollTimer = null;

function startDrugPanelPolling() {
  clearInterval(drugPanelPollTimer); // idempotent: don't stack a second interval on re-selection
  loadDrugPanel();
  drugPanelPollTimer = setInterval(loadDrugPanel, 30000);
}

function stopDrugPanelPolling() {
  clearInterval(drugPanelPollTimer);
  drugPanelPollTimer = null;
}

/** Inline detail for one drug - rendered directly under its own row, not appended after the whole list. */
function renderDrugExpansion(drug) {
  const patientsList = drug.patients
    .map((p) => `<span class="condition-tag">${escapeHtml(p.name)}</span>`)
    .join("");

  const shortageBlock = drug.shortage
    ? `
      <h3>Active shortage</h3>
      <div class="evidence-row"><span>Status</span><span>${escapeHtml(drug.shortage.status)}</span></div>
      <div class="evidence-row"><span>Source</span><span>${drug.shortage.source === "fda_live" ? "Live FDA data" : "Demo fixture"}</span></div>
      <div class="evidence-row"><span>Updated</span><span>${escapeHtml(drug.shortage.updateDate)}</span></div>`
    : "";

  const recallBlock = drug.recall
    ? `
      <h3>Active recall</h3>
      <div class="evidence-row"><span>Classification</span><span>${escapeHtml(drug.recall.classification)}</span></div>
      <div class="evidence-row"><span>Source</span><span>${drug.recall.source === "fda_live" ? "Live FDA data" : "Demo fixture"}</span></div>
      <div class="evidence-row"><span>Recalled by</span><span>${escapeHtml(drug.recall.recallingFirm)}</span></div>
      <div class="evidence-row"><span>Reason</span><span>${escapeHtml(drug.recall.reason)}</span></div>
      <div class="evidence-row"><span>Distribution</span><span>${escapeHtml(drug.recall.distributionPattern)}</span></div>
      <div class="evidence-row"><span>Product</span><span>${escapeHtml(drug.recall.productDescription)}</span></div>
      <div class="evidence-row"><span>Initiated</span><span>${escapeHtml(formatFdaDate(drug.recall.initiatedDate) ?? "unknown")}</span></div>`
    : "";

  return `
    <div class="drug-expansion">
      <div class="condition-tags">${patientsList || `<span class="muted small">No patient currently prescribed this.</span>`}</div>
      ${shortageBlock}
      ${recallBlock}
      ${!drug.shortage && !drug.recall ? `<div class="empty-note"><i class="ph ph-check-circle"></i> No active FDA shortage or recall for this medication.</div>` : ""}
    </div>`;
}

function renderDrugList() {
  const container = el("drug-list");
  if (!state.drugs.length) {
    container.innerHTML = `<div class="empty-note"><i class="ph ph-check-circle"></i> No medications on the panel yet.</div>`;
    return;
  }
  container.innerHTML = state.drugs
    .map((d) => {
      const expanded = d.name === activeDrugName;
      const pills = [
        d.shortage ? `<span class="pill pill-danger">Shortage</span>` : "",
        d.recall ? `<span class="pill pill-warn">${escapeHtml(d.recall.classification)} recall</span>` : "",
        !d.shortage && !d.recall ? `<span class="pill pill-ok">No active issue</span>` : "",
      ].join("");
      return `
      <div class="drug-item">
        <button class="case-row ${expanded ? "active" : ""}" data-open-drug="${escapeHtml(d.name)}" aria-expanded="${expanded}">
          <span class="case-row-main">
            <div class="case-row-title">${escapeHtml(d.name)}</div>
            <div class="case-row-sub">${d.patients.length} patient${d.patients.length === 1 ? "" : "s"} affected</div>
          </span>
          <span class="drug-row-right">
            <span class="alert-row-pills">${pills}</span>
            <i class="ph ${expanded ? "ph-caret-up" : "ph-caret-down"} drug-caret"></i>
          </span>
        </button>
        ${expanded ? renderDrugExpansion(d) : ""}
      </div>`;
    })
    .join("");
}

/** Clicking an open drug's row closes it; clicking a different one switches which is open (one at a time). */
function toggleDrug(name) {
  activeDrugName = activeDrugName === name ? null : name;
  renderDrugList();
}

async function loadEventFeed(containerId = "event-feed") {
  const container = el(containerId);
  try {
    const events = await fetchJSON("/api/events?limit=30");
    villageLastEvents = events;
    renderAgentVillage(events);
    if (container) container.innerHTML = events.length
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
    if (container) container.innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
}

function setVillageAgent(name, { confidence, stateLabel, task, speech, working = true }) {
  const pct = Math.max(0, Math.min(100, confidence));
  el(`confidence-${name}`).textContent = `${pct}%`;
  el(`meter-${name}`).style.width = `${pct}%`;
  el(`state-${name}`).textContent = stateLabel;
  el(`task-${name}`).textContent = task;
  el(`speech-${name}`).textContent = speech;
  document.querySelector(`[data-agent="${name}"]`)?.classList.toggle("agent-waiting", !working);
  document.querySelector(`[data-runner="${name}"]`)?.classList.toggle("runner-active", working);
}

/** Visualizes only real case/event state; confidence is a transparent evidence-completeness score, not a clinical probability. */
function renderAgentVillage(events = villageLastEvents) {
  const open = state.cases.filter((c) => c.status !== "resolved");
  const supply = open.filter((c) => c.triggerType === "supply_risk");
  const interactions = open.filter((c) => c.triggerType === "interaction_risk");
  const hasEvents = events.length > 0;
  const toolEvent = events.find((e) => e.type === "tool_call" || e.type === "tool_result");
  const latest = events[0];
  const rxEvidence = state.cases.filter((c) => c.evidence?.daysUntilDue != null).length;
  const fdaLive = state.cases.filter((c) => c.evidence?.source === "fda_live").length;
  const resolved = state.cases.filter((c) => c.status === "resolved").length;
  const inventoryCases = state.cases.filter((c) => c.fulfillment?.lastCheckedStock != null || c.fulfillment?.stockAtOrder != null);
  const notificationCount = state.missionStats?.notificationsSent ?? 0;
  const approvals = open.filter((c) => c.status === "approval_required");

  const rxConfidence = state.cases.length ? Math.min(98, 68 + rxEvidence * 5) : 64;
  const fdaConfidence = state.cases.length ? Math.min(97, 66 + fdaLive * 6 + supply.length * 2) : 61;
  const safetyConfidence = state.cases.length ? Math.min(96, 72 + interactions.length * 8 + resolved * 2) : 66;

  setVillageAgent("rx", {
    confidence: rxConfidence,
    stateLabel: rxEvidence ? "VERIFIED" : "FETCHING",
    task: rxEvidence ? `${rxEvidence} refill timeline${rxEvidence === 1 ? "" : "s"} grounded` : "Reading patient prescriptions",
    speech: rxEvidence ? `I found ${rxEvidence} dated refill signal${rxEvidence === 1 ? "" : "s"}!` : "Checking refill windows…",
    working: Boolean(open.length || hasEvents),
  });
  setVillageAgent("fda", {
    confidence: fdaConfidence,
    stateLabel: supply.length ? "TRACKING" : "SYNCED",
    task: supply.length ? `${supply.length} active supply case${supply.length === 1 ? "" : "s"}` : "Shortage intelligence synchronized",
    speech: supply.length ? `${supply.length} shortage signal${supply.length === 1 ? "" : "s"} routed!` : "FDA channel is clear.",
    working: Boolean(supply.length || fdaLive || toolEvent),
  });
  setVillageAgent("safety", {
    confidence: safetyConfidence,
    stateLabel: interactions.length ? "REVIEWING" : "CLEAR",
    task: interactions.length ? `${interactions.length} interaction case${interactions.length === 1 ? "" : "s"} under review` : "Interaction evidence checked",
    speech: interactions.length ? `Flagged ${interactions.length} safety review!` : "Safety cross-check complete.",
    working: Boolean(interactions.length || toolEvent),
  });
  setVillageAgent("inventory", {
    confidence: inventoryCases.length ? Math.min(99, 76 + inventoryCases.length * 4) : 54,
    stateLabel: inventoryCases.length ? "COUNTED" : supply.length ? "DISPATCHED" : "STANDBY",
    task: inventoryCases.length ? `${inventoryCases.length} stock check${inventoryCases.length === 1 ? "" : "s"} recorded` : supply.length ? "Walking to the stock room" : "Inventory route is clear",
    speech: inventoryCases.length ? `${inventoryCases.length} shelf count${inventoryCases.length === 1 ? "" : "s"} delivered!` : supply.length ? "On my way to inventory!" : "Shelves ready for checks.",
    working: Boolean(supply.length || inventoryCases.length),
  });
  setVillageAgent("notify", {
    confidence: notificationCount ? 98 : approvals.length ? 82 : 48,
    stateLabel: notificationCount ? "DELIVERED" : approvals.length ? "AT GATE" : "STANDBY",
    task: notificationCount ? `${notificationCount} approved notice${notificationCount === 1 ? "" : "s"} delivered` : approvals.length ? "Waiting at the human approval gate" : "No approved notification queued",
    speech: notificationCount ? "Message delivered safely!" : approvals.length ? "I’ll wait here for approval." : "No message leaves without approval!",
    working: Boolean(notificationCount),
  });

  const totalCases = state.missionStats?.totalCases ?? state.cases.length;
  const resolvedCases = state.missionStats?.resolvedCases ?? resolved;
  const resolutionPct = totalCases ? Math.round((resolvedCases / totalCases) * 100) : 100;
  el("quest-resolved").textContent = `${resolvedCases}/${totalCases} quests cleared`;
  el("quest-resolved-meter").style.width = `${resolutionPct}%`;
  el("quest-evidence").textContent = `${state.missionStats?.liveEvidenceCases ?? fdaLive} verified`;
  el("quest-stock").textContent = `${state.missionStats?.inventoryChecks ?? inventoryCases.length} completed`;
  el("quest-deliveries").textContent = `${notificationCount} sent`;

  el("village-summary").textContent = open.length
    ? `${open.length} open case${open.length === 1 ? "" : "s"} moving through the village right now.`
    : "All current signals have been routed; specialists remain on watch.";
  el("village-sync").textContent = latest ? formatRelativeTime(latest.timestamp) : "standing by";
  el("orchestrator-task").textContent = latest?.label || (open.length ? `Prioritizing ${open.length} open case${open.length === 1 ? "" : "s"}` : "Monitoring the patient panel");
  el("speech-orchestrator").textContent = latest?.type === "approval_required"
    ? "Human decision needed at the gate!"
    : open.length
      ? "Team, triangulate the evidence!"
      : "Nice work—stay alert!";
}

const villageAgentDetails = {
  rx: ["Rx Scout", "Connects real refill dates to each patient and returns grounded continuity signals."],
  fda: ["FDA Ranger", "Retrieves shortage and recall intelligence, preserving whether evidence is live or a demo fixture."],
  safety: ["Safety Sage", "Cross-checks medication combinations and routes high-risk findings for human review."],
  inventory: ["Inventory Keeper", "Checks the synthetic pharmacy stock source before any routine refill can be placed."],
  notify: ["Notification Courier", "Delivers simulated patient notices only after the required action or approval succeeds."],
};

function inspectVillageAgent(name) {
  const [title, description] = villageAgentDetails[name];
  document.querySelectorAll(".pixel-station").forEach((station) => station.classList.toggle("selected", station.dataset.agent === name));
  el("agent-inspector").innerHTML = `<span class="inspector-avatar">${name === "notify" ? "✉" : name === "inventory" ? "▣" : "⌁"}</span><div><small>VISUAL SPECIALIST ROLE</small><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div><span class="inspector-hint">Current: ${escapeHtml(el(`task-${name}`).textContent)}</span>`;
}

function initializeVillageInteractions() {
  const village = document.querySelector(".agent-village");
  el("view-mission-control").querySelector(".view-heading").after(village);
  document.querySelectorAll(".pixel-station").forEach((station) => {
    station.addEventListener("click", () => inspectVillageAgent(station.dataset.agent));
    station.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspectVillageAgent(station.dataset.agent); }
    });
  });
  el("village-pause").addEventListener("click", () => {
    const paused = el("view-mission-control").classList.toggle("village-paused");
    el("village-pause").setAttribute("aria-pressed", String(paused));
    el("village-pause").innerHTML = paused ? `<i class="ph ph-play"></i> Play` : `<i class="ph ph-pause"></i> Pause`;
  });
  el("village-speed").addEventListener("click", () => {
    villageSpeed = villageSpeed === 1 ? 1.75 : villageSpeed === 1.75 ? 0.65 : 1;
    el("view-mission-control").style.setProperty("--village-speed", String(villageSpeed));
    el("village-speed").innerHTML = `<i class="ph ph-lightning"></i> ${villageSpeed}×`;
  });
}

async function loadToolCallStat() {
  try {
    const stats = await fetchJSON("/api/mission-control/stats");
    state.missionStats = stats;
    renderAgentVillage();
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
  // Idempotent: clicking the already-selected tab repeatedly must not start
  // additional intervals — previously only the latest timer ID was kept,
  // so earlier ones kept running (and compounding) uncleared.
  clearInterval(missionControlPollTimer);
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
  el("view-drug-panel").classList.toggle("hidden", viewName !== "drug-panel");
  el("view-mission-control").classList.toggle("hidden", viewName !== "mission-control");

  if (viewName === "mission-control") startMissionControlPolling();
  else stopMissionControlPolling();

  if (viewName === "drug-panel") startDrugPanelPolling();
  else stopDrugPanelPolling();

  if (viewName === "patient-panel") startPatientPanelPolling();
  else stopPatientPanelPolling();
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

  const openDrugBtn = e.target.closest("[data-open-drug]");
  if (openDrugBtn) return toggleDrug(openDrugBtn.dataset.openDrug);

  const gotoCase = e.target.closest("[data-goto-case]");
  if (gotoCase) {
    switchView("mission-control");
    return openCase(gotoCase.dataset.gotoCase);
  }


  const recallBtn = e.target.closest("[data-acknowledge-recall]");
  if (recallBtn) {
    return acknowledgeRecall(
      recallBtn.dataset.acknowledgeRecall,
      recallBtn.dataset.patientId,
      recallBtn.dataset.patientName,
      recallBtn.dataset.medName
    );
  }

  const approveBtn = e.target.closest("[data-approve]");
  if (approveBtn) return respondToApproval(approveBtn.dataset.approve, "allow");

  const rejectBtn = e.target.closest("[data-reject]");
  if (rejectBtn) return respondToApproval(rejectBtn.dataset.reject, "deny");
});

// Drug Panel is the default/first tab - switchView sets its tab/view state
// and starts its own polling. The sidebar and Patient Panel's alert data
// load eagerly regardless of which tab is active: the sidebar is always
// visible, and cases must be reconciled before anything that reads them
// (overview alerts need it to link a supply-risk row to its real case;
// agent-status needs it so "N cases require attention" doesn't read a
// cases.json that hasn't been reconciled yet and disagree with the
// Drug Panel numbers shown right above it).
initializeVillageInteractions();
switchView("drug-panel");
loadPatientList();
loadCases().then(() => Promise.all([loadOverviewAlerts(), loadAgentStatus()]));
setInterval(loadAgentStatus, 5000);
