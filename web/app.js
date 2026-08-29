// PharmaFlow dashboard — vanilla JS, no framework/build step.

const state = {
  patients: [],
  activePatientId: null,
  activeCaseId: null,
  cases: [],
  drugs: [],
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

function setCheckedIcon(iconId, checked) {
  el(iconId).className = checked ? "ph ph-check-circle" : "ph ph-circle-dashed";
}

async function loadAgentStatus() {
  try {
    const status = await fetchJSON("/api/agent-status");
    el("status-fda").textContent = formatRelativeTime(status.lastChecked.fda);
    el("status-prescriptions").textContent = formatRelativeTime(status.lastChecked.prescriptions);
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
    state.supplyRiskAlerts = await fetchJSON("/api/supply-risk");
    renderSupplyRiskBanner();
  } catch (err) {
    el("supply-risk-banner").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }

  renderPatientList(); // now that alert data is in, refresh sidebar concern counts
}

/**
 * A single prominent summary, not a per-row list - the doc's own framing is
 * that supply risk is PharmaFlow's primary story, and the per-case detail
 * (evidence, patient supply, approval) already lives one click away in
 * Mission Control. Counts are real distinct patients/medications, and the
 * only claim made - "FDA updates detected" - is one this data backs.
 */
function renderSupplyRiskBanner() {
  const alerts = state.supplyRiskAlerts;
  const banner = el("supply-risk-banner");

  if (!alerts.length) {
    banner.innerHTML = `<div class="empty-note"><i class="ph ph-check-circle"></i> No active FDA shortages match this panel's medications.</div>`;
    return;
  }

  const patientCount = new Set(alerts.map((a) => a.patientId)).size;
  const medCount = new Set(alerts.map((a) => a.medicationName)).size;

  banner.innerHTML = `
    <button class="supply-banner-inner" data-goto-mission-control>
      <div class="supply-banner-head"><span class="dot dot-critical"></span><strong>Active supply risks</strong></div>
      <div class="supply-banner-stats">
        <div><span class="supply-banner-value">${patientCount}</span> patient${patientCount === 1 ? "" : "s"}</div>
        <div><span class="supply-banner-value">${medCount}</span> medication${medCount === 1 ? "" : "s"}</div>
        <div>FDA updates detected</div>
      </div>
    </button>`;
}

// ---- Patient detail ----

async function openPatient(id) {
  state.activePatientId = id;
  renderPatientList();
  el("alerts-section").classList.add("hidden");
  el("agent-status-strip").classList.add("hidden");
  el("supply-risk-banner").classList.add("hidden");
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
  el("supply-risk-banner").classList.remove("hidden");
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

/** Finds the real case backing an alert, if one exists yet - used to make Patient Panel alerts open their case. */
function findCaseForAlert(patientId, medicationName) {
  return state.cases.find((c) => c.patientId === patientId && c.medicationName === medicationName) ?? null;
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
    const days = kase.evidence.daysUntilDue;
    const supplyText =
      days == null ? null : days < 0 ? `${Math.abs(days)} days past the patient's own supply` : `${days} days remaining`;
    return `
      <div class="evidence-row"><span>Source</span><span>${kase.evidence.source === "fda_live" ? "Live FDA data" : "Demo fixture"}</span></div>
      <div class="evidence-row"><span>FDA status</span><span>${escapeHtml(kase.evidence.status)}</span></div>
      ${kase.evidence.updateDate ? `<div class="evidence-row"><span>Updated</span><span>${escapeHtml(kase.evidence.updateDate)}</span></div>` : ""}
      ${supplyText ? `<div class="evidence-row"><span>Patient supply</span><span>${escapeHtml(supplyText)}</span></div>` : ""}
      <div class="evidence-row"><span>Pharmacy inventory</span><span class="muted">Not tracked in this prototype</span></div>
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
    ${renderCaseLifecycle(kase.status)}
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
  } catch (err) {
    el("drug-list").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
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
  el("view-drug-panel").classList.toggle("hidden", viewName !== "drug-panel");
  el("view-mission-control").classList.toggle("hidden", viewName !== "mission-control");

  if (viewName === "mission-control") startMissionControlPolling();
  else stopMissionControlPolling();

  if (viewName === "drug-panel") loadDrugPanel();
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

  if (e.target.closest("[data-goto-mission-control]")) return switchView("mission-control");

  const approveBtn = e.target.closest("[data-approve]");
  if (approveBtn) return respondToApproval(approveBtn.dataset.approve, "allow");

  const rejectBtn = e.target.closest("[data-reject]");
  if (rejectBtn) return respondToApproval(rejectBtn.dataset.reject, "deny");
});

// Cases load (and reconcile against live data) before anything that reads
// them: overview alerts need it to link a supply-risk row to its real
// case from the very first paint, and agent-status needs it so "N cases
// require attention" doesn't read a cases.json that hasn't been
// reconciled yet and transiently disagree with the alerts right below it.
loadPatientList();
loadCases().then(() => Promise.all([loadOverviewAlerts(), loadAgentStatus()]));
setInterval(loadAgentStatus, 5000);
