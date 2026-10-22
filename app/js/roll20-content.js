// Runs on app.roll20.net in the extension's isolated world. Two jobs:
//
// 1. SEND_TO_ROLL20 - post a chat line (roll forwarding). Same DOM hooks as
//    the roll20-wild-magic extension: Roll20's chat textarea
//    (`#textchat-input textarea`) and its send button (`#chatSendBtn`).
// 2. R20_SYNC / R20_HP / R20_INSPECT / R20_STATUS - character sync. Those
//    need Roll20's own game objects, which only exist in the page's context,
//    so they're relayed to roll20-page.js (manifest "world": "MAIN") over
//    window.postMessage and the reply is passed back to the background worker.
// 3. HP coming back from Roll20 - tells roll20-page.js which characters are
//    synced (WATCH, from `characterLinks` in chrome.storage) and passes its
//    HP_CHANGED reports on to the background worker (R20_HP_CHANGED), which
//    hands them to the character sheet tab.

const FROM_ISOLATED = "cs-roll20-isolated";
const FROM_PAGE = "cs-roll20-page";

/** Tries to find and use the chat box, retrying while the game is still loading. */
function trySend(text) {
  return new Promise((resolve) => {
    function attempt(retriesLeft) {
      const textarea = document.querySelector("#textchat-input textarea");
      const button = document.querySelector("#chatSendBtn");

      if (textarea && button) {
        textarea.value = text;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        button.click();
        textarea.value = "";
        resolve(true);
        return;
      }

      if (retriesLeft > 0) {
        setTimeout(() => attempt(retriesLeft - 1), 200);
      } else {
        resolve(false);
      }
    }

    attempt(10);
  });
}

let requestCounter = 0;

/** Asks roll20-page.js to run `type` and resolves with its result (or a timeout error). */
function askPage(type, payload, timeoutMs = 25000) {
  const requestId = `r${Date.now().toString(36)}-${++requestCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: "Roll20 page didn't respond - reload the Roll20 tab and try again." });
    }, timeoutMs);
    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== FROM_PAGE || data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data.result);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: FROM_ISOLATED, type, payload, requestId }, location.origin);
  });
}

const PAGE_REQUESTS = { R20_SYNC: "SYNC", R20_HP: "HP", R20_INSPECT: "INSPECT", R20_STATUS: "STATUS" };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_TO_ROLL20") {
    trySend(message.text).then((ok) => sendResponse({ ok }));
    return true; // async response
  }

  const pageType = PAGE_REQUESTS[message.type];
  if (pageType) {
    askPage(pageType, message.payload).then(sendResponse);
    return true;
  }
});

// --- Roll20 -> character sheet: HP --------------------------------------------

const STORAGE_KEY_LINKS = "characterLinks";
const STORAGE_KEY_PROFILE = "sheetProfile";

/** Tells roll20-page.js which Roll20 characters are linked to a character sheet character. */
async function sendWatchList() {
  let stored;
  try {
    stored = await chrome.storage.local.get([STORAGE_KEY_LINKS, STORAGE_KEY_PROFILE]);
  } catch {
    return; // extension was reloaded - this copy of the script is orphaned
  }
  const links = stored[STORAGE_KEY_LINKS] && typeof stored[STORAGE_KEY_LINKS] === "object" ? stored[STORAGE_KEY_LINKS] : {};
  const characters = Object.entries(links)
    .filter(([, link]) => link && link.roll20CharacterId)
    .map(([sheetCharacterId, link]) => ({ sheetCharacterId, roll20CharacterId: link.roll20CharacterId }));
  window.postMessage(
    { source: FROM_ISOLATED, type: "WATCH", payload: { characters, profile: stored[STORAGE_KEY_PROFILE] || "auto" } },
    location.origin
  );
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== FROM_PAGE || data.requestId) return;
  if (data.type === "PAGE_READY") sendWatchList();
  if (data.type === "HP_CHANGED" && data.payload) {
    try {
      chrome.runtime.sendMessage({ type: "R20_HP_CHANGED", payload: data.payload }).catch(() => undefined);
    } catch {
      // extension was reloaded - reload the Roll20 tab to reconnect
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_KEY_LINKS] || changes[STORAGE_KEY_PROFILE])) sendWatchList();
});

sendWatchList();
