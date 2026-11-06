const STORAGE_KEY_LOG = "forwardedRolls";
const STORAGE_KEY_ENABLED = "autoForwardEnabled";
const STORAGE_KEY_PROFILE = "sheetProfile";
const STORAGE_KEY_LINKS = "characterLinks";
const STORAGE_KEY_FORMAT = "chatFormat";
const STORAGE_KEY_UPDATE = "pendingUpdate";

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

async function initFormatSelect() {
  const select = document.getElementById("formatSelect");
  const stored = await chrome.storage.local.get([STORAGE_KEY_FORMAT]);
  select.value = stored[STORAGE_KEY_FORMAT] === "plain" ? "plain" : "template";
  select.addEventListener("change", () => {
    chrome.storage.local.set({ [STORAGE_KEY_FORMAT]: select.value });
  });
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

// --- Updates -----------------------------------------------------------------

function setUpdateStatus(text, kind) {
  const el = document.getElementById("updateStatus");
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

/** Shows "Restart to update" when background.js has recorded a downloaded update. */
async function renderPendingUpdate() {
  const stored = await chrome.storage.local.get([STORAGE_KEY_UPDATE]);
  const pending = stored[STORAGE_KEY_UPDATE];
  const applyBtn = document.getElementById("applyUpdateBtn");
  applyBtn.hidden = !pending;
  if (pending) {
    setUpdateStatus(`Version ${pending.version} is ready to install.`, "ok");
    applyBtn.textContent = `Restart to update to v${pending.version}`;
  }
  return Boolean(pending);
}

/** "development" = loaded unpacked from a folder; those never update from the Web Store. */
async function isUnpacked() {
  try {
    const self = await chrome.management.getSelf();
    return self.installType === "development";
  } catch {
    return false;
  }
}

async function checkForUpdates() {
  const button = document.getElementById("checkUpdateBtn");
  if (await isUnpacked()) {
    setUpdateStatus("Developer copy (loaded unpacked) - pull the new files into its folder, then press Reload.", "warn");
    button.textContent = "Reload extension";
    button.onclick = () => chrome.runtime.reload();
    return;
  }

  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const result = await chrome.runtime.requestUpdateCheck();
    // Chrome 109+ resolves with { status, version }; older builds passed (status, details).
    const status = typeof result === "string" ? result : result && result.status;
    const version = result && typeof result === "object" ? result.version : undefined;
    if (status === "update_available") {
      // Chrome is downloading it now; onUpdateAvailable (background.js) fires when it's ready.
      if (!(await renderPendingUpdate())) {
        setUpdateStatus(`Version ${version || "(new)"} found - downloading…`, "ok");
      }
    } else if (status === "throttled") {
      setUpdateStatus("Checked too recently - try again in a few minutes.", "warn");
    } else {
      setUpdateStatus(`You have the latest version (v${chrome.runtime.getManifest().version}).`, "ok");
    }
  } catch (error) {
    setUpdateStatus(`Update check failed: ${error && error.message ? error.message : error}`, "warn");
  } finally {
    button.disabled = false;
    button.textContent = "Check for updates";
  }
}

function initUpdates() {
  document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
  document.getElementById("checkUpdateBtn").onclick = checkForUpdates;
  document.getElementById("applyUpdateBtn").addEventListener("click", () => chrome.runtime.reload());
  renderPendingUpdate();
}

document.addEventListener("DOMContentLoaded", () => {
  renderStatus();
  renderLog();
  initToggle();
  renderSync();
  initProfileSelect();
  initFormatSelect();
  initUpdates();
  document.getElementById("inspectBtn").addEventListener("click", inspect);

  document.getElementById("testBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "SEND_TEST_ROLL", visibility: "public" });
    setTimeout(renderLog, 300);
  });

  document.getElementById("testGmBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "SEND_TEST_ROLL", visibility: "gm" });
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
  if (changes[STORAGE_KEY_UPDATE]) renderPendingUpdate();
});
