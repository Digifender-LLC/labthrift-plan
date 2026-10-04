import {
  startRegistration,
  startAuthentication,
} from "/vendor/simplewebauthn-browser/index.js";

const themeKey = "lab-plan-theme";
const tourKey = "lab-plan-tour-done-v2";
const paneKey = "lab-plan-pane";
const hideCompletedKey = "lab-plan-hide-completed";

let me = null;
let lab = null;
let saveTimer = null;
let saveGen = 0;
let dirty = false;
let forceNextSave = false;
let conflictOpen = false;
let bomFilter = "all";
let passkeyCount = 0;
let online = typeof navigator !== "undefined" ? navigator.onLine : true;

const $ = (id) => document.getElementById(id);

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function showErr(el, msg) {
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.textContent = msg;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function applyTheme() {
  const t = localStorage.getItem(themeKey) || "auto";
  if (t === "auto") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-theme", t);
  }
  document.querySelectorAll('input[name="themePick"]').forEach((r) => {
    r.checked = r.value === t;
  });
}

function setTheme(next) {
  localStorage.setItem(themeKey, next);
  applyTheme();
}

$("themeBtn").onclick = () => {
  const cur = localStorage.getItem(themeKey) || "auto";
  const next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
  setTheme(next);
};

document.querySelectorAll('input[name="themePick"]').forEach((r) => {
  r.onchange = () => {
    if (r.checked) setTheme(r.value);
  };
});

// Only the browser's own offline state skips a save attempt. A failed request marks the banner
// offline, but the next save still tries, so a transient error cannot leave edits stuck unsaved.
function browserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function setOfflineBanner() {
  const el = $("offlineBanner");
  if (!el) return;
  el.classList.toggle("hidden", online);
}

function cloudPasskeyAckKey() {
  return me?.username ? `lab-plan-cloud-passkey-ack:${me.username}` : null;
}

function hasCloudPasskeyAck() {
  const k = cloudPasskeyAckKey();
  if (!k) return false;
  try {
    return localStorage.getItem(k) === "1";
  } catch (_) {
    return false;
  }
}

function setCloudPasskeyAck() {
  const k = cloudPasskeyAckKey();
  if (!k) return;
  try {
    localStorage.setItem(k, "1");
  } catch (_) {}
}

function setPasskeyNudge() {
  const el = $("passkeyNudge");
  const why = $("passkeyWhy");
  if (!el) return;
  const show = !!me && passkeyCount === 1 && !hasCloudPasskeyAck();
  el.classList.toggle("hidden", !show);
  if (!show) why?.classList.add("hidden");
}

function setConflictBar(on) {
  conflictOpen = !!on;
  $("conflictBar")?.classList.toggle("hidden", !on);
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
  } catch (e) {
    online = false;
    setOfflineBanner();
    const err = new Error("network_error");
    err.code = "network_error";
    err.status = 0;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json().catch(() => ({})) : await res.text();
  // The service worker answers API/auth GETs with this 503 when the network is down.
  if (res.status === 503 && body && body.error === "offline") {
    online = false;
    setOfflineBanner();
    const err = new Error("network_error");
    err.code = "network_error";
    err.status = 0;
    throw err;
  }
  if (!online) {
    online = true;
    setOfflineBanner();
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || res.statusText);
    err.code = body && body.error;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function setGate(on) {
  $("gate").classList.toggle("hidden", !on);
  $("app").classList.toggle("hidden", on);
  $("logoutBtn").classList.toggle("hidden", on);
  $("who").classList.toggle("hidden", on);
  if (on) {
    $("passkeyNudge")?.classList.add("hidden");
    $("passkeyWhy")?.classList.add("hidden");
    setConflictBar(false);
  }
}

function markDirty() {
  dirty = true;
  scheduleSave();
}

let liveRenderTimer = 0;
function scheduleLiveRender() {
  clearTimeout(liveRenderTimer);
  liveRenderTimer = setTimeout(() => {
    renderHeadroom();
    // Refresh host dropdown labels without fighting focused service fields
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#svcList")) return;
    const pane = document.querySelector("#pane-services.active");
    if (pane) renderServices();
  }, 400);
}

function scheduleSave() {
  if (!lab) return;
  if (browserOffline()) {
    // Don't rely on the window "offline" event alone to show the banner.
    online = false;
    setOfflineBanner();
    $("saveMsg").textContent = "Offline — will retry when back";
    return;
  }
  $("saveMsg").textContent = "Saving…";
  const gen = ++saveGen;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(gen), 450);
}

// Saves run one at a time so each one is based on the version the previous save returned.
let saveChain = Promise.resolve();
function persist(gen, opts) {
  saveChain = saveChain.then(() => persistNow(gen, opts));
  return saveChain;
}

async function persistNow(gen, { force = false } = {}) {
  if (!lab) return;
  if (browserOffline()) {
    online = false;
    setOfflineBanner();
    dirty = true;
    $("saveMsg").textContent = "Offline — will retry when back";
    return;
  }
  const target = lab;
  try {
    const snapshot = JSON.parse(JSON.stringify(lab));
    delete snapshot.id;
    if (force || forceNextSave) {
      snapshot.force = true;
      forceNextSave = false;
    }
    const res = await api("/api/lab", { method: "PUT", body: JSON.stringify(snapshot) });
    // The notebook was replaced meanwhile (reload, import, sign-out): this result no longer applies.
    if (target !== lab) return;
    // Always track the server's latest version, even if newer edits are already queued.
    lab.updated_at = res.updated_at;
    if (gen !== saveGen) return;
    dirty = false;
    setConflictBar(false);
    $("saveMsg").textContent = "Saved " + new Date(res.updated_at).toLocaleTimeString();
  } catch (e) {
    if (target !== lab) return;
    if (e.status === 409 && e.body) {
      dirty = true;
      setConflictBar(true);
      $("saveMsg").textContent = "Conflict — open elsewhere";
      return;
    }
    dirty = true;
    if (e.code === "network_error") {
      $("saveMsg").textContent = "Couldn't save — retry when online";
    } else {
      $("saveMsg").textContent = "Couldn't save — retry: " + (e.message || e);
    }
  }
}

$("saveBtn").onclick = () => {
  saveGen++;
  persist(saveGen);
};

$("conflictReload").onclick = async () => {
  try {
    lab = await api("/api/lab");
    dirty = false;
    setConflictBar(false);
    renderAll();
    $("saveMsg").textContent = "Reloaded from server";
  } catch (e) {
    $("saveMsg").textContent = "Reload failed: " + e.message;
  }
};

$("conflictForce").onclick = () => {
  forceNextSave = true;
  saveGen++;
  persist(saveGen, { force: true });
};

window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && dirty && !browserOffline()) {
    saveGen++;
    persist(saveGen);
  }
});

window.addEventListener("online", () => {
  online = true;
  setOfflineBanner();
  if (dirty) {
    saveGen++;
    persist(saveGen);
  }
});
window.addEventListener("offline", () => {
  online = false;
  setOfflineBanner();
});

/* --- panes / hash --- */
const PANES = ["stuff", "services", "headroom", "weekend", "closet", "hosts", "bom", "settings"];

function activatePane(pane, { persistHash = true } = {}) {
  if (!PANES.includes(pane)) pane = "stuff";
  document.querySelectorAll("#tabs [role='tab']").forEach((b) => {
    const on = b.dataset.pane === pane;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".pane").forEach((p) => {
    p.classList.toggle("active", p.id === "pane-" + pane);
  });
  try {
    sessionStorage.setItem(paneKey, pane);
  } catch (_) {}
  if (persistHash) {
    const hash = "#" + pane;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  if (pane === "settings") refreshPasskeys();
}

function paneFromLocation() {
  const h = (location.hash || "").replace(/^#/, "");
  if (PANES.includes(h)) return h;
  try {
    const s = sessionStorage.getItem(paneKey);
    if (PANES.includes(s)) return s;
  } catch (_) {}
  return "stuff";
}

document.querySelectorAll("#tabs [role='tab']").forEach((btn) => {
  btn.onclick = () => activatePane(btn.dataset.pane);
});

$("tabs")?.addEventListener("keydown", (e) => {
  const tabs = [...document.querySelectorAll("#tabs [role='tab']")];
  const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
  if (i < 0) return;
  let next = i;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabs.length - 1;
  else return;
  e.preventDefault();
  tabs[next].focus();
  activatePane(tabs[next].dataset.pane);
});

window.addEventListener("hashchange", () => {
  const h = (location.hash || "").replace(/^#/, "");
  if (PANES.includes(h)) activatePane(h, { persistHash: false });
});

/* --- inventory --- */
const INV_ROLES = [
  { v: "", label: "Role…" },
  { v: "pc", label: "PC" },
  { v: "nas", label: "NAS" },
  { v: "pi", label: "Pi" },
  { v: "switch", label: "Switch" },
  { v: "ap", label: "AP" },
  { v: "other", label: "Other" },
];

function ensureInventoryIds() {
  lab.inventory = (lab.inventory || []).map((it) => {
    const out = {
      id: typeof it.id === "string" && it.id ? it.id : newId(),
      name: it.name || "",
      note: it.note || "",
    };
    if (typeof it.role === "string" && it.role) out.role = it.role;
    if (typeof it.cpu === "number") out.cpu = it.cpu;
    if (typeof it.ramGb === "number") out.ramGb = it.ramGb;
    if (typeof it.storageGb === "number") out.storageGb = it.storageGb;
    if (typeof it.watts === "number") out.watts = it.watts;
    if (it.needsAttention === true) out.needsAttention = true;
    if (typeof it.attentionNote === "string" && it.attentionNote) out.attentionNote = it.attentionNote;
    return out;
  });
}

function setOptNum(obj, key, raw) {
  const s = String(raw ?? "").trim();
  if (!s) {
    delete obj[key];
    return;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return;
  obj[key] = n;
}

function renderInventory() {
  ensureInventoryIds();
  const root = $("invList");
  root.innerHTML = "";
  (lab.inventory || []).forEach((it, i) => {
    const div = document.createElement("div");
    div.className = "item inv-item" + (it.needsAttention ? " needs-attention" : "");
    const roleOpts = INV_ROLES.map(
      (r) => `<option value="${r.v}"${(it.role || "") === r.v ? " selected" : ""}>${r.label}</option>`
    ).join("");
    const known = INV_ROLES.some((r) => r.v && r.v === it.role);
    const customRole =
      it.role && !known
        ? `<option value="${esc(it.role)}" selected>${esc(it.role)}</option>`
        : "";
    div.innerHTML = `
      <div class="inv-main">
        <input data-k="name" placeholder="Name (old PC, switch…)" />
        <input data-k="note" placeholder="Note" />
        <button type="button" class="secondary" data-rm>Remove</button>
      </div>
      <label class="check inv-attn">
        <input type="checkbox" data-k="needsAttention" />
        <span>Needs attention</span>
      </label>
      <input data-k="attentionNote" class="inv-attn-note${it.needsAttention ? "" : " hidden"}" placeholder="What's wrong / what to fix" maxlength="240" />
      <details class="inv-specs">
        <summary>Specs (optional)</summary>
        <div class="inv-specs-grid">
          <label>Role
            <select data-k="role">${roleOpts}${customRole}</select>
          </label>
          <label>CPU (cores)
            <input type="number" data-k="cpu" min="0" max="512" step="1" placeholder="—" />
          </label>
          <label>RAM (GB)
            <input type="number" data-k="ramGb" min="0" max="4096" step="0.5" placeholder="—" />
          </label>
          <label>Storage (GB)
            <input type="number" data-k="storageGb" min="0" max="1048576" step="1" placeholder="—" />
          </label>
          <label>Watts
            <input type="number" data-k="watts" min="0" max="50000" step="1" placeholder="—" />
          </label>
        </div>
      </details>`;
    div.querySelector('[data-k="name"]').value = it.name || "";
    div.querySelector('[data-k="note"]').value = it.note || "";
    div.querySelector('[data-k="needsAttention"]').checked = !!it.needsAttention;
    div.querySelector('[data-k="attentionNote"]').value = it.attentionNote || "";
    ["cpu", "ramGb", "storageGb", "watts"].forEach((k) => {
      const el = div.querySelector(`[data-k="${k}"]`);
      if (el && it[k] != null) el.value = it[k];
    });
    div.querySelector('[data-k="name"]').oninput = (e) => {
      lab.inventory[i].name = e.target.value;
      markDirty();
      scheduleLiveRender();
    };
    div.querySelector('[data-k="note"]').oninput = (e) => {
      lab.inventory[i].note = e.target.value;
      markDirty();
    };
    div.querySelector('[data-k="needsAttention"]').onchange = (e) => {
      if (e.target.checked) lab.inventory[i].needsAttention = true;
      else delete lab.inventory[i].needsAttention;
      div.classList.toggle("needs-attention", !!e.target.checked);
      div.querySelector('[data-k="attentionNote"]').classList.toggle("hidden", !e.target.checked);
      markDirty();
    };
    div.querySelector('[data-k="attentionNote"]').oninput = (e) => {
      const v = e.target.value;
      if (v) lab.inventory[i].attentionNote = v;
      else delete lab.inventory[i].attentionNote;
      markDirty();
    };
    div.querySelector('[data-k="role"]').onchange = (e) => {
      const v = e.target.value;
      if (v) lab.inventory[i].role = v;
      else delete lab.inventory[i].role;
      markDirty();
    };
    ["cpu", "ramGb", "storageGb", "watts"].forEach((k) => {
      div.querySelector(`[data-k="${k}"]`).oninput = (e) => {
        setOptNum(lab.inventory[i], k, e.target.value);
        markDirty();
        scheduleLiveRender();
      };
    });
    div.querySelector("[data-rm]").onclick = () => {
      const removedId = lab.inventory[i].id;
      lab.inventory.splice(i, 1);
      (lab.services || []).forEach((s) => {
        if (s.hostId === removedId) delete s.hostId;
      });
      renderInventory();
      renderServices();
      renderHeadroom();
      markDirty();
    };
    root.appendChild(div);
  });
}

$("addInv").onclick = () => {
  ensureInventoryIds();
  lab.inventory.push({ id: newId(), name: "", note: "" });
  renderInventory();
  markDirty();
};

/* --- services --- */
const SERVICE_PRESETS = [
  { name: "Pi-hole", ramMb: 512, cpuPct: 5 },
  { name: "Immich", ramMb: 2048, cpuPct: 25 },
  { name: "Samba", ramMb: 256, cpuPct: 5 },
  { name: "Home Assistant", ramMb: 1024, cpuPct: 10 },
  { name: "Jellyfin", ramMb: 2048, cpuPct: 30 },
  { name: "Nextcloud", ramMb: 1024, cpuPct: 15 },
  { name: "WireGuard", ramMb: 128, cpuPct: 2 },
];

function ensureServices() {
  lab.services = (lab.services || []).map((s) => {
    const out = {
      id: typeof s.id === "string" && s.id ? s.id : newId(),
      name: s.name || "",
    };
    if (typeof s.hostId === "string" && s.hostId) out.hostId = s.hostId;
    if (typeof s.ramMb === "number") out.ramMb = s.ramMb;
    if (typeof s.cpuPct === "number") out.cpuPct = s.cpuPct;
    if (typeof s.notes === "string" && s.notes) out.notes = s.notes;
    if (typeof s.url === "string" && s.url) out.url = s.url;
    return out;
  });
}

function hostOptionsHtml(selected) {
  ensureInventoryIds();
  const opts = ['<option value="">— host —</option>'];
  (lab.inventory || []).forEach((it) => {
    const label = (it.name || "unnamed") + (it.role ? ` (${it.role})` : "");
    const sel = selected && selected === it.id ? " selected" : "";
    opts.push(`<option value="${esc(it.id)}"${sel}>${esc(label)}</option>`);
  });
  return opts.join("");
}

function renderServicePresets() {
  const root = $("servicePresets");
  if (!root) return;
  root.innerHTML = "";
  const hint = document.createElement("span");
  hint.className = "muted preset-hint";
  hint.textContent = "Presets (rough guesses):";
  root.appendChild(hint);
  SERVICE_PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = `${p.name} ~${p.ramMb}MB/${p.cpuPct}%`;
    btn.title = "Rough guess — not a benchmark";
    btn.onclick = () => {
      ensureServices();
      lab.services.push({
        id: newId(),
        name: p.name,
        ramMb: p.ramMb,
        cpuPct: p.cpuPct,
      });
      renderServices();
      renderHeadroom();
      markDirty();
    };
    root.appendChild(btn);
  });
}

function renderServices() {
  ensureServices();
  ensureInventoryIds();
  const root = $("svcList");
  if (!root) return;
  root.innerHTML = "";
  if (!(lab.services || []).length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No services yet — add one or tap a preset above.";
    root.appendChild(empty);
  }
  (lab.services || []).forEach((s, i) => {
    const div = document.createElement("div");
    div.className = "item svc-item";
    div.innerHTML = `
      <div class="svc-main">
        <input data-k="name" placeholder="Service name" maxlength="120" />
        <select data-k="hostId">${hostOptionsHtml(s.hostId || "")}</select>
        <button type="button" class="secondary" data-rm>Remove</button>
      </div>
      <div class="svc-nums">
        <label>RAM (MB)
          <input type="number" data-k="ramMb" min="0" max="1048576" step="64" placeholder="—" />
        </label>
        <label>CPU %
          <input type="number" data-k="cpuPct" min="0" max="1000" step="1" placeholder="—" />
        </label>
        <label>URL
          <input type="url" data-k="url" maxlength="300" placeholder="https://…" />
        </label>
      </div>
      <input data-k="notes" placeholder="Notes" maxlength="240" />`;
    div.querySelector('[data-k="name"]').value = s.name || "";
    if (s.ramMb != null) div.querySelector('[data-k="ramMb"]').value = s.ramMb;
    if (s.cpuPct != null) div.querySelector('[data-k="cpuPct"]').value = s.cpuPct;
    div.querySelector('[data-k="url"]').value = s.url || "";
    div.querySelector('[data-k="notes"]').value = s.notes || "";
    div.querySelector('[data-k="name"]').oninput = (e) => {
      lab.services[i].name = e.target.value;
      markDirty();
      renderHeadroom();
    };
    div.querySelector('[data-k="hostId"]').onchange = (e) => {
      const v = e.target.value;
      if (v) lab.services[i].hostId = v;
      else delete lab.services[i].hostId;
      markDirty();
      scheduleLiveRender();
    };
    div.querySelector('[data-k="ramMb"]').oninput = (e) => {
      setOptNum(lab.services[i], "ramMb", e.target.value);
      markDirty();
      scheduleLiveRender();
    };
    div.querySelector('[data-k="cpuPct"]').oninput = (e) => {
      setOptNum(lab.services[i], "cpuPct", e.target.value);
      markDirty();
      scheduleLiveRender();
    };
    div.querySelector('[data-k="url"]').oninput = (e) => {
      const v = e.target.value.trim();
      if (v) lab.services[i].url = v;
      else delete lab.services[i].url;
      markDirty();
    };
    div.querySelector('[data-k="notes"]').oninput = (e) => {
      const v = e.target.value;
      if (v) lab.services[i].notes = v;
      else delete lab.services[i].notes;
      markDirty();
    };
    div.querySelector("[data-rm]").onclick = () => {
      lab.services.splice(i, 1);
      renderServices();
      renderHeadroom();
      markDirty();
    };
    root.appendChild(div);
  });
}

$("addSvc").onclick = () => {
  ensureServices();
  lab.services.push({ id: newId(), name: "" });
  renderServices();
  markDirty();
};

/* --- headroom --- */
function fmtMb(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(mb >= 10240 ? 0 : 1) + " GB";
  return Math.round(mb) + " MB";
}

function barHtml(pct, over) {
  const w = Math.min(100, Math.max(0, pct));
  const cls = over ? "bar-fill over" : pct >= 85 ? "bar-fill warn" : "bar-fill";
  return `<div class="bar"><div class="${cls}" style="width:${w}%"></div></div>`;
}

function renderHeadroom() {
  if (!lab) return;
  ensureInventoryIds();
  ensureServices();
  const root = $("headroomHosts");
  const powerEl = $("headroomPower");
  if (!root) return;

  const upsInput = $("upsVa");
  const noteInput = $("powerNote");
  if (upsInput && document.activeElement !== upsInput) {
    upsInput.value = lab.upsVa != null ? lab.upsVa : "";
  }
  if (noteInput && document.activeElement !== noteInput) {
    noteInput.value = lab.powerNote || "";
  }

  root.innerHTML = "";
  const hosts = (lab.inventory || []).filter(
    (it) => it.ramGb != null || it.cpu != null || it.watts != null || (lab.services || []).some((s) => s.hostId === it.id)
  );
  if (!hosts.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "Add specs on Stuff items (RAM GB, watts) and assign services to hosts to see headroom bars.";
    root.appendChild(p);
  }

  hosts.forEach((host) => {
    const svcs = (lab.services || []).filter((s) => s.hostId === host.id);
    const ramUsedMb = svcs.reduce((a, s) => a + (s.ramMb || 0), 0);
    const ramAvailMb = host.ramGb != null ? host.ramGb * 1024 : null;
    const cpuSum = svcs.reduce((a, s) => a + (s.cpuPct || 0), 0);
    const card = document.createElement("div");
    card.className = "item headroom-card";
    let body = `<strong>${(host.name || "unnamed").replace(/</g, "&lt;")}</strong>`;
    if (host.role) body += ` <span class="chip-lite">${esc(host.role)}</span>`;
    if (host.needsAttention) body += ` <span class="attn-badge">attention</span>`;
    body += `<div class="muted" style="margin:0.35rem 0">Services: ${svcs.length || "none"}</div>`;

    if (ramAvailMb != null) {
      const pct = ramAvailMb > 0 ? (ramUsedMb / ramAvailMb) * 100 : 0;
      const over = ramUsedMb > ramAvailMb;
      body += `<div class="hr-row"><span>RAM ${fmtMb(ramUsedMb)} / ${fmtMb(ramAvailMb)}</span>${barHtml(pct, over)}</div>`;
    } else if (ramUsedMb > 0) {
      body += `<div class="hr-row"><span>RAM used ${fmtMb(ramUsedMb)} (set host RAM GB)</span>${barHtml(0, false)}</div>`;
    }

    const cpuOver = cpuSum > 100;
    body += `<div class="hr-row"><span>CPU share ${Math.round(cpuSum)}%${host.cpu != null ? ` · ${host.cpu} cores noted` : ""}</span>${barHtml(cpuSum, cpuOver)}</div>`;

    if (svcs.length) {
      body += `<ul class="hr-svc-list">${svcs
        .map((s) => {
          const bits = [s.name || "service"];
          if (s.ramMb != null) bits.push(fmtMb(s.ramMb));
          if (s.cpuPct != null) bits.push(s.cpuPct + "%");
          return `<li>${bits.join(" · ").replace(/</g, "&lt;")}</li>`;
        })
        .join("")}</ul>`;
    }
    card.innerHTML = body;
    root.appendChild(card);
  });

  const wattsSum = (lab.inventory || []).reduce((a, it) => a + (it.watts || 0), 0);
  if (powerEl) {
    const ups = lab.upsVa;
    let msg = `House watt sum (from Stuff): ${wattsSum || 0} W`;
    if (ups != null && ups > 0) {
      // Rough VA≈W for sketch; label clearly
      const pct = (wattsSum / ups) * 100;
      const over = wattsSum > ups;
      msg += ` · UPS ${ups} VA sketch → ~${Math.round(pct)}% of VA (W≈VA ballpark)`;
      if (over) msg += " — over VA sketch";
      powerEl.innerHTML = `<div class="hr-row"><span>${msg}</span>${barHtml(pct, over)}</div>`;
    } else {
      powerEl.textContent = msg + (wattsSum ? " — set UPS VA above for a sketch bar" : "");
    }
    if (lab.powerNote) {
      const note = document.createElement("div");
      note.className = "muted";
      note.style.marginTop = "0.35rem";
      note.textContent = lab.powerNote;
      powerEl.appendChild(note);
    }
  }
}

if ($("upsVa")) {
  $("upsVa").oninput = (e) => {
    if (!lab) return;
    setOptNum(lab, "upsVa", e.target.value);
    if (lab.upsVa == null) delete lab.upsVa;
    markDirty();
    scheduleLiveRender();
  };
}
if ($("powerNote")) {
  $("powerNote").oninput = (e) => {
    if (!lab) return;
    const v = e.target.value;
    if (v) lab.powerNote = v;
    else delete lab.powerNote;
    markDirty();
    scheduleLiveRender();
  };
}

/* --- weekend checklist --- */
function renderChecklist() {
  const root = $("checkList");
  root.innerHTML = "";
  const entries = Object.entries(lab.checklist || {});
  const done = entries.filter(([, item]) => item.done).length;
  const total = entries.length;
  const summary = $("weekendSummary");
  if (summary) summary.textContent = `${done} of ${total} done`;
  const hide = $("hideCompleted")?.checked;

  entries.forEach(([key, item]) => {
    if (hide && item.done) return;
    const div = document.createElement("label");
    div.className = "check";
    div.innerHTML = `<input type="checkbox" /> <span><a href="${item.href}" target="_blank" rel="noopener">${item.label}</a></span>`;
    const box = div.querySelector("input");
    box.checked = !!item.done;
    box.onchange = () => {
      lab.checklist[key].done = box.checked;
      renderChecklist();
      markDirty();
    };
    root.appendChild(div);
  });
}

$("hideCompleted").onchange = () => {
  try {
    sessionStorage.setItem(hideCompletedKey, $("hideCompleted").checked ? "1" : "0");
  } catch (_) {}
  renderChecklist();
};

/**
 * Closet slot migration:
 * Canonical shape is { start, height, name, inventoryId? }.
 */
function migrateClosetSlots(slots) {
  return (slots || []).map((s) => {
    if (!s || typeof s !== "object") {
      return { start: 1, height: 1, name: "" };
    }
    let start = 1;
    let height = 1;
    if (typeof s.start === "number" || typeof s.height === "number") {
      start = Math.max(1, Number(s.start) || 1);
      height = Math.max(1, Number(s.height) || 1);
    } else if (typeof s.startU === "number") {
      start = Math.max(1, Number(s.startU) || 1);
      height = Math.max(1, Number(s.height) || 1);
    } else {
      // Legacy { u, name }: u = start, height = 1
      start = Math.max(1, Number(s.u) || 1);
      height = 1;
    }
    const base = { start, height, name: String(s.name || "") };
    if (typeof s.inventoryId === "string" && s.inventoryId) base.inventoryId = s.inventoryId;
    return base;
  });
}

function ensureCloset() {
  if (!lab.closet || typeof lab.closet !== "object") {
    lab.closet = { units: 12, slots: [], ports: [] };
  }
  lab.closet.units = Math.min(42, Math.max(1, Number(lab.closet.units) || 12));
  lab.closet.slots = migrateClosetSlots(lab.closet.slots);
  lab.closet.ports = Array.isArray(lab.closet.ports)
    ? lab.closet.ports.map((p) => ({
        port: String(p?.port ?? ""),
        label: String(p?.label ?? ""),
      }))
    : [];
}

let rackEdit = null;
let portEditIndex = null;

function slotOccupies(slot, u) {
  const end = slot.start + slot.height - 1;
  return u >= slot.start && u <= end;
}

function slotsOverlap(aStart, aHeight, bStart, bHeight) {
  const aEnd = aStart + aHeight - 1;
  const bEnd = bStart + bHeight - 1;
  return aStart <= bEnd && bStart <= aEnd;
}

function placementError(start, height, ignoreIndex) {
  const units = lab.closet.units;
  if (!Number.isFinite(start) || start < 1) return "Start U must be at least 1.";
  if (!Number.isFinite(height) || height < 1) return "Height must be at least 1 U.";
  if (start + height - 1 > units) {
    return `That span (U${start}–U${start + height - 1}) exceeds the rack (${units}U).`;
  }
  for (let i = 0; i < lab.closet.slots.length; i++) {
    if (i === ignoreIndex) continue;
    const s = lab.closet.slots[i];
    if (slotsOverlap(start, height, s.start, s.height)) {
      const label = s.name?.trim() || "unnamed gear";
      return `Overlaps “${label}” at U${s.start}–U${s.start + s.height - 1}.`;
    }
  }
  return "";
}

function showRackErr(msg) {
  const el = $("rackErr");
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.textContent = msg;
}

function fillInvLinkSelect(selectedId) {
  const sel = $("slotInvLink");
  if (!sel) return;
  ensureInventoryIds();
  sel.innerHTML = '<option value="">— none —</option>';
  (lab.inventory || []).forEach((it) => {
    const opt = document.createElement("option");
    opt.value = it.id;
    opt.textContent = it.name?.trim() || "(unnamed item)";
    if (selectedId && selectedId === it.id) opt.selected = true;
    sel.appendChild(opt);
  });
}

function openRackEditor(state) {
  rackEdit = state;
  const form = $("rackEditorForm");
  const hint = $("rackEditorHint");
  form.classList.remove("hidden");
  hint.classList.add("hidden");
  showRackErr("");
  if (state.mode === "place") {
    $("rackEditorHeading").textContent = `Place gear at U${state.start}`;
    $("slotName").value = "";
    $("slotStart").value = String(state.start);
    $("slotHeight").value = "1";
    $("slotStart").max = String(lab.closet.units);
    $("slotHeight").max = String(lab.closet.units - state.start + 1);
    $("slotPlaceBtn").textContent = "Place";
    $("slotRemoveBtn").classList.add("hidden");
    fillInvLinkSelect("");
  } else {
    const slot = lab.closet.slots[state.index];
    $("rackEditorHeading").textContent = `Edit gear at U${slot.start}`;
    $("slotName").value = slot.name || "";
    $("slotStart").value = String(slot.start || 1);
    $("slotHeight").value = String(slot.height || 1);
    $("slotStart").max = String(lab.closet.units);
    $("slotHeight").max = String(lab.closet.units);
    $("slotPlaceBtn").textContent = "Save";
    $("slotRemoveBtn").classList.remove("hidden");
    fillInvLinkSelect(slot.inventoryId || "");
  }
  $("slotName").focus();
  renderRack();
}

function closeRackEditor() {
  rackEdit = null;
  $("rackEditorForm").classList.add("hidden");
  $("rackEditorHint").classList.remove("hidden");
  showRackErr("");
  renderRack();
}

function bindRackKey(btn, activate) {
  btn.tabIndex = 0;
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
}

function renderRack() {
  const root = $("rackViz");
  if (!root) return;
  root.innerHTML = "";
  const units = lab.closet.units;
  root.style.display = "grid";
  root.style.gridTemplateColumns = "2.5rem minmax(0, 1fr)";
  root.style.gridTemplateRows = `repeat(${units}, minmax(40px, auto))`;

  for (let u = units; u >= 1; u--) {
    const gridRow = units - u + 1;
    const labEl = document.createElement("div");
    labEl.className = "rack-u-label";
    labEl.textContent = "U" + u;
    labEl.style.gridColumn = "1";
    labEl.style.gridRow = String(gridRow);
    root.appendChild(labEl);
  }

  const covered = new Set();
  (lab.closet.slots || []).forEach((slot) => {
    for (let u = slot.start; u < slot.start + slot.height; u++) covered.add(u);
  });

  for (let u = units; u >= 1; u--) {
    if (covered.has(u)) continue;
    const gridRow = units - u + 1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rack-empty";
    btn.setAttribute("aria-label", `Place gear at U${u}`);
    btn.textContent = "+";
    btn.style.gridColumn = "2";
    btn.style.gridRow = String(gridRow);
    const activate = () => openRackEditor({ mode: "place", start: u });
    btn.onclick = activate;
    bindRackKey(btn, activate);
    root.appendChild(btn);
  }

  (lab.closet.slots || []).forEach((slot, index) => {
    const end = slot.start + slot.height - 1;
    if (slot.start > units) return;
    const visEnd = Math.min(end, units);
    const visHeight = visEnd - slot.start + 1;
    if (visHeight < 1) return;
    const topU = visEnd;
    const gridRowStart = units - topU + 1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rack-gear";
    if (rackEdit?.mode === "edit" && rackEdit.index === index) {
      btn.classList.add("active");
    }
    btn.style.gridColumn = "2";
    btn.style.gridRow = `${gridRowStart} / span ${visHeight}`;
    const name = document.createElement("span");
    name.className = "rack-gear-name";
    name.textContent = slot.name?.trim() || "Unnamed";
    const span = document.createElement("span");
    span.className = "rack-gear-span";
    span.textContent =
      (slot.height > 1 ? `${slot.height}U` : "1U") + (end > units ? " (!)" : "");
    btn.appendChild(name);
    btn.appendChild(span);
    btn.setAttribute(
      "aria-label",
      `Edit ${name.textContent} at U${slot.start}, ${slot.height}U`
    );
    const activate = () => openRackEditor({ mode: "edit", start: slot.start, index });
    btn.onclick = activate;
    bindRackKey(btn, activate);
    root.appendChild(btn);
  });
}

$("slotInvLink").onchange = (e) => {
  const id = e.target.value;
  if (!id) return;
  const it = (lab.inventory || []).find((x) => x.id === id);
  if (it?.name) $("slotName").value = it.name;
};

function applySlotFromEditor() {
  if (!rackEdit) return;
  const name = $("slotName").value;
  const height = Math.max(1, Number($("slotHeight").value) || 1);
  const start = Math.max(1, Number($("slotStart").value) || rackEdit.start);
  const ignore = rackEdit.mode === "edit" ? rackEdit.index : -1;
  const err = placementError(start, height, ignore);
  if (err) {
    showRackErr(err);
    return;
  }
  const inventoryId = $("slotInvLink").value || undefined;
  const slot = { start, height, name };
  if (inventoryId) slot.inventoryId = inventoryId;
  if (rackEdit.mode === "place") {
    lab.closet.slots.push(slot);
  } else {
    lab.closet.slots[rackEdit.index] = slot;
  }
  closeRackEditor();
  markDirty();
}

$("slotPlaceBtn").onclick = applySlotFromEditor;
$("slotCancelBtn").onclick = () => closeRackEditor();
$("slotRemoveBtn").onclick = () => {
  if (!rackEdit || rackEdit.mode !== "edit") return;
  lab.closet.slots.splice(rackEdit.index, 1);
  closeRackEditor();
  markDirty();
};
$("slotHeight").onkeydown = (e) => {
  if (e.key === "Enter") applySlotFromEditor();
};
$("slotName").onkeydown = (e) => {
  if (e.key === "Enter") applySlotFromEditor();
};
$("slotStart").onkeydown = (e) => {
  if (e.key === "Enter") applySlotFromEditor();
};

function renderPorts() {
  const root = $("portGrid");
  root.innerHTML = "";
  (lab.closet.ports || []).forEach((it, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "port-chip" + (it.label?.trim() ? " labeled" : "");
    if (portEditIndex === i) btn.classList.add("active");
    btn.setAttribute("role", "listitem");
    const num = document.createElement("span");
    num.className = "port-chip-num";
    num.textContent = it.port?.trim() ? `#${it.port.trim()}` : "Port";
    const labEl = document.createElement("span");
    labEl.className = "port-chip-label";
    labEl.textContent = it.label?.trim() || "—";
    btn.appendChild(num);
    btn.appendChild(labEl);
    btn.onclick = () => openPortEditor(i);
    root.appendChild(btn);
  });
  if (portEditIndex != null && portEditIndex >= (lab.closet.ports || []).length) {
    closePortEditor();
  } else if (portEditIndex != null) {
    syncPortEditorFields();
  }
}

function syncPortEditorFields() {
  const it = lab.closet.ports[portEditIndex];
  if (!it) return;
  $("portNum").value = it.port || "";
  $("portLabel").value = it.label || "";
}

function openPortEditor(i) {
  portEditIndex = i;
  $("portEditor").classList.remove("hidden");
  syncPortEditorFields();
  renderPorts();
  $("portNum").focus();
}

function closePortEditor() {
  portEditIndex = null;
  $("portEditor").classList.add("hidden");
  renderPorts();
}

$("portNum").oninput = (e) => {
  if (portEditIndex == null) return;
  lab.closet.ports[portEditIndex].port = e.target.value;
  renderPorts();
  markDirty();
};
$("portLabel").oninput = (e) => {
  if (portEditIndex == null) return;
  lab.closet.ports[portEditIndex].label = e.target.value;
  renderPorts();
  markDirty();
};
$("portRemoveBtn").onclick = () => {
  if (portEditIndex == null) return;
  lab.closet.ports.splice(portEditIndex, 1);
  closePortEditor();
  markDirty();
};
$("portDoneBtn").onclick = () => closePortEditor();

function clampSlotsToUnits(newUnits) {
  const removed = [];
  const kept = [];
  for (const slot of lab.closet.slots || []) {
    if (slot.start > newUnits) {
      removed.push(slot);
      continue;
    }
    const end = slot.start + slot.height - 1;
    if (end > newUnits) {
      const clamped = { ...slot, height: newUnits - slot.start + 1 };
      kept.push(clamped);
    } else {
      kept.push(slot);
    }
  }
  return { kept, removed };
}

$("rackUnits").oninput = (e) => {
  ensureCloset();
  const next = Math.min(42, Math.max(1, Number(e.target.value) || 12));
  const prev = lab.closet.units;
  if (next < prev) {
    const { kept, removed } = clampSlotsToUnits(next);
    const overhang = (lab.closet.slots || []).filter(
      (s) => s.start > next || s.start + s.height - 1 > next
    );
    if (overhang.length) {
      const names = overhang
        .map((s) => s.name?.trim() || `U${s.start}`)
        .join(", ");
      const ok = confirm(
        `Lowering to ${next}U will clamp or remove gear that no longer fits (${names}). Continue?`
      );
      if (!ok) {
        e.target.value = String(prev);
        return;
      }
      lab.closet.slots = kept;
      if (rackEdit?.mode === "edit") {
        const still = kept[rackEdit.index];
        if (!still) closeRackEditor();
      }
    }
  }
  lab.closet.units = next;
  if (rackEdit?.mode === "place") {
    $("slotHeight").max = String(lab.closet.units - Number($("slotStart").value || rackEdit.start) + 1);
    $("slotStart").max = String(lab.closet.units);
  } else if (rackEdit?.mode === "edit") {
    $("slotStart").max = String(lab.closet.units);
    $("slotHeight").max = String(lab.closet.units);
  }
  renderRack();
  markDirty();
};

$("addPort").onclick = () => {
  ensureCloset();
  lab.closet.ports.push({ port: String(lab.closet.ports.length + 1), label: "" });
  openPortEditor(lab.closet.ports.length - 1);
  markDirty();
};

function hostsSnippet() {
  return (lab.hosts || [])
    .filter((h) => h.ip && h.hostname)
    .map((h) => `${h.ip}\t${h.hostname}`)
    .join("\n");
}

function renderHosts() {
  const root = $("hostList");
  root.innerHTML = "";
  (lab.hosts || []).forEach((it, i) => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <input data-k="hostname" placeholder="hostname" />
      <input data-k="ip" placeholder="192.168.x.x" />
      <input data-k="note" placeholder="Note (USB disk…)" />
      <button type="button" class="secondary" data-rm>Remove</button>`;
    ["hostname", "ip", "note"].forEach((k) => {
      div.querySelector(`[data-k="${k}"]`).value = it[k] || "";
      div.querySelector(`[data-k="${k}"]`).oninput = (e) => {
        lab.hosts[i][k] = e.target.value;
        $("hostsPreview").textContent = hostsSnippet();
        markDirty();
      };
    });
    div.querySelector("[data-rm]").onclick = () => {
      lab.hosts.splice(i, 1);
      renderHosts();
      markDirty();
    };
    root.appendChild(div);
  });
  $("hostsPreview").textContent = hostsSnippet();
}

$("addHost").onclick = () => {
  lab.hosts = lab.hosts || [];
  lab.hosts.push({ hostname: "", ip: "", note: "" });
  renderHosts();
  markDirty();
};
$("copyHosts").onclick = async () => {
  await navigator.clipboard.writeText(hostsSnippet());
  $("saveMsg").textContent = "Hosts snippet copied";
};

function renderBom() {
  const root = $("bomList");
  root.innerHTML = "";
  (lab.bom || []).forEach((it, i) => {
    if (bomFilter !== "all" && (it.status || "consider") !== bomFilter) return;
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <input data-k="slug" placeholder="guide-slug or labthrift.com/guides/…" />
      <div class="bom-status-chips" role="group" aria-label="Status"></div>
      <input data-k="note" placeholder="Why / skip reason" />
      <a class="muted" data-link target="_blank" rel="noopener">Open note</a>
      <button type="button" class="secondary" data-rm>Remove</button>`;
    const slugEl = div.querySelector('[data-k="slug"]');
    slugEl.value = it.slug || "";
    div.querySelector('[data-k="note"]').value = it.note || "";
    const chips = div.querySelector(".bom-status-chips");
    ["consider", "skip", "bought"].forEach((st) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + ((it.status || "consider") === st ? " active" : "");
      b.dataset.status = st;
      b.textContent = st;
      b.onclick = () => {
        lab.bom[i].status = st;
        renderBom();
        markDirty();
      };
      chips.appendChild(b);
    });
    const link = div.querySelector("[data-link]");
    const syncLink = () => {
      let slug = (lab.bom[i].slug || "").trim();
      const m = slug.match(/labthrift\.com\/guides\/([^/?#]+)/i);
      if (m) slug = m[1];
      lab.bom[i].slug = slug;
      link.href = slug ? `https://labthrift.com/guides/${slug}` : "#";
    };
    syncLink();
    slugEl.oninput = (e) => {
      lab.bom[i].slug = e.target.value;
      syncLink();
      markDirty();
    };
    div.querySelector('[data-k="note"]').oninput = (e) => {
      lab.bom[i].note = e.target.value;
      markDirty();
    };
    div.querySelector("[data-rm]").onclick = () => {
      lab.bom.splice(i, 1);
      renderBom();
      markDirty();
    };
    root.appendChild(div);
  });
}

document.querySelectorAll("[data-bom-filter]").forEach((btn) => {
  btn.onclick = () => {
    bomFilter = btn.dataset.bomFilter;
    document.querySelectorAll("[data-bom-filter]").forEach((b) => {
      b.classList.toggle("active", b.dataset.bomFilter === bomFilter);
    });
    renderBom();
  };
});

$("addBom").onclick = () => {
  lab.bom = lab.bom || [];
  lab.bom.push({ slug: "", status: "consider", note: "" });
  renderBom();
  markDirty();
};

function syncTitleInput() {
  const el = $("labTitle");
  if (!el || !lab) return;
  el.value = lab.title || "My lab";
}

$("labTitle").oninput = (e) => {
  if (!lab) return;
  lab.title = e.target.value.slice(0, 80);
  markDirty();
};

function renderAll() {
  ensureCloset();
  ensureInventoryIds();
  ensureServices();
  $("rackUnits").value = lab.closet.units;
  syncTitleInput();
  rackEdit = null;
  portEditIndex = null;
  $("rackEditorForm").classList.add("hidden");
  $("rackEditorHint").classList.remove("hidden");
  $("portEditor").classList.add("hidden");
  showRackErr("");
  try {
    $("hideCompleted").checked = sessionStorage.getItem(hideCompletedKey) === "1";
  } catch (_) {}
  renderInventory();
  renderServicePresets();
  renderServices();
  renderHeadroom();
  renderChecklist();
  renderRack();
  renderPorts();
  renderHosts();
  renderBom();
}

/* --- onboarding tour --- */
const TOUR_STEPS = [
  {
    title: "Welcome to your lab plan",
    body: "Panes keep house-lab notes in one place — stuff, services, headroom, weekend path, and more. A short tour, then you’re in.",
  },
  {
    title: "Stuff I have",
    body: "List the old PC, disks, switch, and APs you already own — expand for rough specs and attention flags.",
    pane: "stuff",
  },
  {
    title: "Services & headroom",
    body: "Park services on hosts with rough RAM/CPU guesses. Headroom sketches used vs available — not live metrics.",
    pane: "services",
  },
  {
    title: "Weekend path",
    body: "Check off Labthrift start-path guides as you finish them.",
    pane: "weekend",
  },
  {
    title: "Closet map",
    body: "Sketch rack U heights and switch ports — rough is fine.",
    pane: "closet",
  },
  {
    title: "House names & later buys",
    body: "Hostnames/IPs live under House names. Pin guide slugs under Later buys.",
    pane: "hosts",
  },
  {
    title: "Add a second passkey",
    body: "Lose every passkey and the account is gone — no email recovery. Add another device under Settings when you can.",
    pane: "settings",
  },
];

let tourStep = 0;

function showTour(step) {
  tourStep = step;
  const overlay = $("tourOverlay");
  if (!overlay) return;
  if (step >= TOUR_STEPS.length) {
    overlay.classList.add("hidden");
    try {
      localStorage.setItem(tourKey, "1");
    } catch (_) {}
    return;
  }
  const s = TOUR_STEPS[step];
  $("tourTitle").textContent = s.title;
  $("tourBody").textContent = s.body;
  $("tourNext").textContent = step === TOUR_STEPS.length - 1 ? "Done" : "Next";
  if (s.pane) activatePane(s.pane);
  overlay.classList.remove("hidden");
}

function maybeStartTour(isNew) {
  try {
    if (localStorage.getItem(tourKey) === "1") return;
  } catch (_) {}
  // Only auto-open after first register; returning users get the passkey nudge banner instead.
  if (isNew) showTour(0);
}

$("tourSkip").onclick = () => showTour(TOUR_STEPS.length);
$("tourNext").onclick = () => showTour(tourStep + 1);

/* --- passkeys --- */
async function refreshPasskeys() {
  if (!me) return;
  try {
    const res = await api("/auth/passkeys");
    passkeyCount = res.passkey_count || (res.passkeys || []).length;
    setPasskeyNudge();
    const msg = $("passkeyCountMsg");
    if (msg) {
      msg.innerHTML = `You have <strong>${passkeyCount}</strong> passkey${
        passkeyCount === 1 ? "" : "s"
      } on this account. Add one on <em>this</em> device, or create a one-time enroll code for a signed-out device.`;
    }
    const root = $("passkeyList");
    if (!root) return;
    root.innerHTML = "";
    (res.passkeys || []).forEach((pk) => {
      const row = document.createElement("div");
      row.className = "passkey-row";
      const when = pk.created_at
        ? new Date(pk.created_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : "";
      const left = document.createElement("div");
      left.innerHTML = `<strong>${pk.label || "Passkey"}</strong><div class="muted">Added ${when} · ${pk.id_hint || ""}</div>`;
      row.appendChild(left);
      if (passkeyCount >= 2) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary";
        btn.textContent = "Revoke";
        btn.onclick = async () => {
          if (!confirm("Revoke this passkey? You need at least one left to sign in.")) return;
          try {
            const out = await api("/auth/passkeys/" + encodeURIComponent(pk.id), {
              method: "DELETE",
            });
            passkeyCount = out.passkey_count ?? passkeyCount - 1;
            $("saveMsg").textContent = "Passkey revoked";
            await refreshPasskeys();
          } catch (e) {
            showErr($("setErr"), e.code === "last_passkey" ? "Keep at least one passkey." : e.message);
          }
        };
        row.appendChild(btn);
      }
      root.appendChild(row);
    });
  } catch (_) {
    /* ignore */
  }
}

async function addPasskeyFlow() {
  showErr($("setErr"), "");
  try {
    const { options } = await api("/auth/passkeys/options", { method: "POST", body: "{}" });
    const credential = await startRegistration({ optionsJSON: options });
    const res = await api("/auth/passkeys/verify", {
      method: "POST",
      body: JSON.stringify({ challenge: options.challenge, credential }),
    });
    passkeyCount = res.passkey_count || passkeyCount + 1;
    setPasskeyNudge();
    $("saveMsg").textContent = "Passkey added";
    await refreshPasskeys();
  } catch (e) {
    showErr($("setErr"), e.message || String(e));
  }
}

$("addPasskeyBtn").onclick = addPasskeyFlow;
$("nudgePasskeyBtn").onclick = () => {
  activatePane("settings");
  addPasskeyFlow();
};

$("nudgeWhyBtn").onclick = () => {
  const why = $("passkeyWhy");
  if (!why) return;
  why.classList.remove("hidden");
  const ack = $("cloudPasskeyAck");
  const btn = $("nudgeOverrideBtn");
  if (ack) ack.checked = false;
  if (btn) btn.disabled = true;
  why.scrollIntoView({ behavior: "smooth", block: "nearest" });
};

$("nudgeWhyClose").onclick = () => {
  $("passkeyWhy")?.classList.add("hidden");
};

$("cloudPasskeyAck").onchange = (e) => {
  $("nudgeOverrideBtn").disabled = !e.target.checked;
};

$("nudgeOverrideBtn").onclick = () => {
  if (!$("cloudPasskeyAck")?.checked) return;
  setCloudPasskeyAck();
  $("passkeyWhy")?.classList.add("hidden");
  setPasskeyNudge();
};

async function enterApp(username, { isNew = false } = {}) {
  me = { username };
  $("who").textContent = "@" + username;
  try {
    const m = await api("/auth/me");
    passkeyCount = m.passkey_count || 0;
  } catch (_) {
    passkeyCount = 0;
  }
  lab = await api("/api/lab");
  setGate(false);
  setPasskeyNudge();
  renderAll();
  activatePane(paneFromLocation());
  maybeStartTour(isNew);
  refreshPasskeys();
}

$("createBtn").onclick = async () => {
  showErr($("gateErr"), "");
  const username = $("username").value.trim();
  try {
    const { options, userId } = await api("/auth/register/options", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    const credential = await startRegistration({ optionsJSON: options });
    await api("/auth/register/verify", {
      method: "POST",
      body: JSON.stringify({ username, userId, challenge: options.challenge, credential }),
    });
    await enterApp(username, { isNew: true });
  } catch (e) {
    showErr(
      $("gateErr"),
      e.code === "username_taken" ? "That username is taken." : e.message || String(e)
    );
  }
};

$("signinBtn").onclick = async () => {
  showErr($("gateErr"), "");
  const username = $("username").value.trim();
  try {
    const { options } = await api("/auth/login/options", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    const credential = await startAuthentication({ optionsJSON: options });
    await api("/auth/login/verify", {
      method: "POST",
      body: JSON.stringify({ username, challenge: options.challenge, credential }),
    });
    await enterApp(username);
  } catch (e) {
    showErr(
      $("gateErr"),
      e.code === "invalid_credentials"
        ? "Sign-in failed. Check the username and use a passkey saved for this account."
        : e.message || String(e)
    );
  }
};

$("logoutBtn").onclick = async () => {
  await api("/auth/logout", { method: "POST", body: "{}" });
  me = null;
  lab = null;
  dirty = false;
  setGate(true);
};

async function doExport() {
  const res = await fetch("/api/lab/export", { credentials: "same-origin" });
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download =
    res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "lab-plan.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

$("exportBtn").onclick = doExport;
$("exportBtnSettings").onclick = doExport;

$("importFile").onchange = async (e) => {
  showErr($("setErr"), "");
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (
    !confirm(
      "Replace your current lab plan with this JSON? This cannot be undone (export first if unsure)."
    )
  ) {
    return;
  }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.schema_version != null) {
      const sv = Number(parsed.schema_version);
      if (sv !== 1 && sv !== 2) {
        showErr($("setErr"), "Unsupported schema_version: " + parsed.schema_version);
        return;
      }
    }
    // Client-side sanitize via worker import
    const res = await api("/api/lab/import", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
    lab = res.lab || (await api("/api/lab"));
    dirty = false;
    renderAll();
    $("saveMsg").textContent = "Imported lab JSON";
  } catch (err) {
    showErr(
      $("setErr"),
      err.code === "unsupported_schema"
        ? "Unsupported schema_version."
        : err.message || String(err)
    );
  }
};

let lastEnrollUrl = "";

$("mintEnrollBtn").onclick = async () => {
  showErr($("setErr"), "");
  try {
    const res = await api("/auth/enroll/create", { method: "POST", body: "{}" });
    lastEnrollUrl = res.url || "";
    const exp = new Date(res.expires_at).toLocaleString();
    $("enrollOut").textContent =
      `Code: ${res.code}\nLink: ${res.url}\nExpires: ${exp}\n\nOn the other device: open the link (or enter username + code on the sign-in page) and create a passkey.`;
    $("copyEnrollBtn").disabled = !lastEnrollUrl;
    $("saveMsg").textContent = "Enroll code created";
  } catch (e) {
    showErr($("setErr"), e.message || String(e));
  }
};

$("copyEnrollBtn").onclick = async () => {
  if (!lastEnrollUrl) return;
  try {
    await navigator.clipboard.writeText(lastEnrollUrl);
    $("saveMsg").textContent = "Enroll link copied";
  } catch {
    $("saveMsg").textContent = "Copy failed — select the link above";
  }
};

$("enrollBtn").onclick = async () => {
  showErr($("gateErr"), "");
  const username = $("enrollUser").value.trim();
  const code = $("enrollCode").value.trim();
  try {
    const { options, userId } = await api("/auth/enroll/options", {
      method: "POST",
      body: JSON.stringify({ username, code }),
    });
    const credential = await startRegistration({ optionsJSON: options });
    const res = await api("/auth/enroll/verify", {
      method: "POST",
      body: JSON.stringify({
        username,
        code,
        userId,
        challenge: options.challenge,
        credential,
      }),
    });
    if (location.search.includes("enroll=")) {
      history.replaceState({}, "", location.pathname);
    }
    await enterApp(res.username || username);
  } catch (e) {
    const msg =
      e.code === "invalid_enroll"
        ? "Invalid or expired enroll code."
        : e.message || String(e);
    showErr($("gateErr"), msg);
  }
};

$("deleteBtn").onclick = async () => {
  if (!confirm("Delete this account and lab plan forever?")) return;
  await api("/auth/me", { method: "DELETE" });
  me = null;
  lab = null;
  dirty = false;
  setGate(true);
};

function prefillEnrollFromQuery() {
  const q = new URLSearchParams(location.search);
  if (q.get("enroll") !== "1") return;
  const user = q.get("user") || "";
  const code = q.get("code") || "";
  if (user) {
    $("enrollUser").value = user;
    $("username").value = user;
  }
  if (code) $("enrollCode").value = code;
}

/* --- PWA install + service worker --- */
let deferredInstallPrompt = null;

function setupInstallHelp() {
  const help = $("installHelp");
  const btn = $("installBtn");
  if (!help || !btn) return;

  const isIos =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;

  if (isStandalone) {
    help.textContent = "Lab plan is installed on this device.";
    btn.classList.add("hidden");
    return;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    help.textContent = "Install Lab plan as an app on this device.";
    btn.classList.remove("hidden");
  });

  btn.onclick = async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } catch (_) {}
    deferredInstallPrompt = null;
    btn.classList.add("hidden");
    help.textContent = "If the prompt closed, use your browser’s Install menu.";
  };

  if (isIos) {
    help.textContent = "On iPhone/iPad: Share → Add to Home Screen.";
  } else if (!deferredInstallPrompt) {
    help.textContent =
      "Use your browser’s Install / Add to Home Screen menu, or on iPhone/iPad: Share → Add to Home Screen.";
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
  const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
  // app.js is loaded with a dynamic import, which usually runs after the page's load event.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

setupInstallHelp();
registerServiceWorker();
setOfflineBanner();
applyTheme();
(async () => {
  try {
    const m = await api("/auth/me");
    passkeyCount = m.passkey_count || 0;
    await enterApp(m.username);
  } catch {
    setGate(true);
    prefillEnrollFromQuery();
  }
})();

