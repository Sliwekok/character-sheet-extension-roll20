const STORAGE_KEY_LOG = "forwardedRolls";
const STORAGE_KEY_ENABLED = "autoForwardEnabled";
const STORAGE_KEY_PROFILE = "sheetProfile";
const STORAGE_KEY_LINKS = "characterLinks";

async function renderStatus() {
  const tabs = await chrome.tabs.query({ url: "*://app.roll20.net/*" });
  const el = document.getElementById("status");
  if (tabs.length > 0) {
    el.textContent = `Connected — ${tabs.length} Roll20 tab${tabs.length > 1 ? "s" : ""} open`;
    el.className = "status ok";
  } else {
    el.textContent = "No Roll20 tab open — open your game to receive rolls";
    el.className = "status warn";
  }
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function renderLog() {
  const stored = await chrome.storage.local.get([STORAGE_KEY_LOG]);
  const list = Array.isArray(stored[STORAGE_KEY_LOG]) ? stored[STORAGE_KEY_LOG] : [];
  const container = document.getElementById("log");
  container.innerHTML = "";

  if (list.length === 0) {
    container.innerHTML = '<p class="empty">No rolls forwarded yet.</p>';
    return;
  }

  for (const entry of list) {
    const row = document.createElement("div");
    row.className = `log-row ${entry.status}`;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatTime(entry.ts);

    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = entry.text;

    row.appendChild(time);
    row.appendChild(text);

    if (entry.status === "failed") {
      const reason = document.createElement("span");
      reason.className = "log-reason";
      reason.textContent = entry.reason || "Failed";
      row.appendChild(reason);
    }

    container.appendChild(row);
  }
}

async function initToggle() {
  const checkbox = document.getElementById("autoForwardToggle");
  const stored = await chrome.storage.local.get([STORAGE_KEY_ENABLED]);
  checkbox.checked = stored[STORAGE_KEY_ENABLED] !== false;
  checkbox.addEventListener("change", () => {
    chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: checkbox.checked });
  });
}

const PROFILE_LABELS = { dnd2024: "D&D 2024 by Roll20", bio: "Bio only" };

async function renderSync() {
  const el = document.getElementById("syncStatus");
  const info = await chrome.runtime.sendMessage({ type: "GET_ROLL20_STATUS" });
  if (info && info.loaded) {
    const gm = info.isGM === false ? " - you're not GM here, sync needs a GM" : "";
    el.textContent = `Game loaded (${info.characters} characters, detected: ${PROFILE_LABELS[info.detectedProfile] || info.detectedProfile})${gm}`;
    el.className = `status ${info.isGM === false ? "warn" : "ok"}`;
  } else {
    el.textContent = (info && info.error) || "Roll20 game not loaded";
    el.className = "status warn";
  }

  const select = document.getElementById("profileSelect");
  select.value = (info && info.profile) || "auto";

  const container = document.getElementById("links");
  container.innerHTML = "";
  const links = Object.values((info && info.links) || {}).sort((a, b) => (b.syncedAt || 0) - (a.syncedAt || 0));
  for (const link of links) {
    const row = document.createElement("div");
    row.className = "link-row";
    const name = document.createElement("span");
    name.textContent = link.roll20Name || link.roll20CharacterId;
    const meta = document.createElement("span");
    meta.className = "link-meta";
    meta.textContent = `synced ${new Date(link.syncedAt).toLocaleDateString()} · HP live`;
    row.append(name, meta);
    container.appendChild(row);
  }
}

function initProfileSelect() {
  document.getElementById("profileSelect").addEventListener("change", (event) => {
    chrome.storage.local.set({ [STORAGE_KEY_PROFILE]: event.target.value });
  });
}

async function inspect() {
  const button = document.getElementById("inspectBtn");
  const name = document.getElementById("inspectName").value.trim();
  button.disabled = true;
  button.textContent = "Reading…";
  const result = await chrome.runtime.sendMessage({ type: "INSPECT_ROLL20", name: name || undefined });
  button.disabled = false;
  button.textContent = "Inspect";
  const el = document.getElementById("syncStatus");
  if (!result || !result.ok) {
    el.textContent = (result && result.error) || "Inspect failed";
    el.className = "status warn";
    return;
  }
  const blob = new Blob([JSON.stringify(result.dump, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "roll20-dump.json";
  a.click();
  el.textContent = `Saved roll20-dump.json (${result.dump.target ? result.dump.target.attribs.length : 0} attributes)`;
  el.className = "status ok";
}

document.addEventListener("DOMContentLoaded", () => {
  renderStatus();
  renderLog();
  initToggle();
  renderSync();
  initProfileSelect();
  document.getElementById("inspectBtn").addEventListener("click", inspect);

  document.getElementById("testBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "SEND_TEST_ROLL" });
    setTimeout(renderLog, 300);
  });

  document.getElementById("clearBtn").addEventListener("click", async () => {
    await chrome.storage.local.set({ [STORAGE_KEY_LOG]: [] });
    renderLog();
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY_LOG]) renderLog();
  if (changes[STORAGE_KEY_LINKS]) renderSync();
});
