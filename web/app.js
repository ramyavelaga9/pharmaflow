// PharmaFlow dashboard — vanilla JS, no framework/build step.

const state = {
  patients: [],
  activePatientId: null,
  conversationId: crypto.randomUUID(),
};

const el = (id) => document.getElementById(id);

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function statusLabel(status) {
  return { overdue: "Overdue", critical: "Due today/tomorrow", "due-soon": "Due soon", ok: "On track" }[status] ?? status;
}
function statusPillClass(status) {
  if (status === "overdue" || status === "critical") return "pill-danger";
  if (status === "due-soon") return "pill-warn";
  return "pill-ok";
}
function statusDotClass(status) {
  if (status === "overdue" || status === "critical") return "dot-critical";
  if (status === "due-soon") return "dot-warn";
  return "dot-ok";
}

// ---- Sidebar: patient list ----

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
        <span class="dot ${statusDotClass(p.worstRefillStatus)}"></span>
        <span class="patient-row-info">
          <div class="patient-row-name">${escapeHtml(p.name)}</div>
          <div class="patient-row-meta">${p.age} &middot; ${p.medicationCount} meds</div>
        </span>
      </button>`
    )
    .join("");
  container.querySelectorAll(".patient-row").forEach((row) => {
    row.addEventListener("click", () => openPatient(row.dataset.id));
  });
}

// ---- Overview: refill + interaction alerts ----

async function loadOverviewAlerts() {
  try {
    const alerts = await fetchJSON("/api/refill-alerts?days=14");
    el("refill-alerts").innerHTML = alerts.length
      ? alerts
          .map(
            (a) => `
        <div class="alert-row">
          <span class="alert-row-main">
            <div class="alert-row-title">${escapeHtml(a.medicationName)} &middot; ${escapeHtml(a.patientName)}</div>
            <div class="alert-row-sub">${a.daysUntilDue < 0 ? `${Math.abs(a.daysUntilDue)}d overdue` : `due in ${a.daysUntilDue}d`}</div>
          </span>
          <span class="pill ${statusPillClass(a.status)}">${statusLabel(a.status)}</span>
        </div>`
          )
          .join("")
      : `<div class="empty-note"><i class="ph ph-check-circle"></i> No refills due in the next two weeks.</div>`;
  } catch (err) {
    el("refill-alerts").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }

  try {
    const alerts = await fetchJSON("/api/interaction-alerts");
    el("interaction-alerts").innerHTML = alerts.length
      ? alerts
          .map(
            (a) => `
        <div class="alert-row">
          <span class="alert-row-main">
            <div class="alert-row-title">${escapeHtml(a.a)} + ${escapeHtml(a.b)} &middot; ${escapeHtml(a.patientName)}</div>
            <div class="alert-row-sub">${escapeHtml(a.note)}</div>
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
    const alerts = await fetchJSON("/api/supply-risk");
    el("supply-risk-alerts").innerHTML = alerts.length
      ? alerts
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
}

// ---- Patient detail ----

async function openPatient(id) {
  state.activePatientId = id;
  renderPatientList();
  el("alerts-section").classList.add("hidden");
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
  el("view-title").textContent = "Panel overview";
  el("view-subtitle").textContent = "Refill, interaction, and supply risk across all patients";
}

function renderPatientDetail(patient) {
  const interactions = patient.interactions
    .map(
      (i) => `
      <div class="interaction-banner">
        <i class="ph ph-warning"></i>
        <div><strong>${escapeHtml(i.a)} + ${escapeHtml(i.b)} (${i.severity} risk)</strong>${escapeHtml(i.note)}</div>
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
          <span class="pill ${statusPillClass(m.refill.status)}">${statusLabel(m.refill.status)}</span>
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

// ---- Chat ----

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
    if (!res.ok || !res.body) throw new Error(`Chat request failed: ${res.status}`);

    const reader = res.body.getReader();
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
        const eventType = eventMatch[1];
        const data = JSON.parse(dataMatch[1]);

        if (eventType === "delta" && data.text) {
          text += data.text;
          agentBubble.textContent = text;
        } else if (eventType === "tool_call" && data.name) {
          if (!toolNotes.has(data.id)) {
            toolNotes.set(data.id, appendChatMessage("tool", `<i class="ph ph-wrench"></i> Calling <code>${escapeHtml(data.name)}</code>`));
          }
        } else if (eventType === "error") {
          appendChatMessage("error", escapeHtml(data.message || "Something went wrong."));
        }
      }
    }
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
  return { session: "ph-plug", tool_call: "ph-wrench", tool_result: "ph-check", turn_done: "ph-flag-checkered" }[type] ?? "ph-dot";
}

async function loadMissionControlStats() {
  try {
    const stats = await fetchJSON("/api/mission-control/stats");
    el("stat-active-cases").textContent = stats.activeCases;
    el("stat-high-risk").textContent = stats.highRisk;
    el("stat-tool-calls").textContent = stats.toolCallsThisSession;
  } catch {
    // Stat tiles just keep their last known value if this poll fails; the
    // event feed below will still surface the connection problem.
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
      : `<p class="empty-note"><i class="ph ph-moon-stars"></i> No agent activity yet. Ask PharmaFlow something in the chat panel.</p>`;
  } catch (err) {
    el("event-feed").innerHTML = `<p class="error-note">${escapeHtml(err.message)}</p>`;
  }
}

function startMissionControlPolling() {
  loadMissionControlStats();
  loadEventFeed();
  missionControlPollTimer = setInterval(() => {
    loadMissionControlStats();
    loadEventFeed();
  }, 4000);
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

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
  if (e.target.closest("#back-to-overview")) backToOverview();
});

loadPatientList();
loadOverviewAlerts();
