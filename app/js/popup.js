const STORAGE_KEY_LOG = "forwardedRolls";
const STORAGE_KEY_ENABLED = "autoForwardEnabled";

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

document.addEventListener("DOMContentLoaded", () => {
  renderStatus();
  renderLog();
  initToggle();

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
});
