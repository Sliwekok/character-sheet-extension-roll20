// Runs on the character sheet page (see manifest.json "matches" -
// localhost/127.0.0.1 by default; widen it if your dev server runs
// somewhere else). Relays the sheet's window.postMessage broadcasts to the
// background service worker, and posts replies back to the page:
//
//   ROLL            -> forwarded to Roll20 chat (from recordRoll)
//   PING            -> answered right here with PONG, so the sheet knows the extension is installed
//   SYNC_CHARACTER  -> full character export ("Sync with Roll20"); reply is SYNC_RESULT
//   HP_UPDATE       -> HP change of an already-synced character (fire and forget)
//
// This content script runs in an isolated world - it can't see the page's
// JS variables directly, which is exactly why the bridge is a postMessage
// (window messaging crosses that boundary by design) rather than a shared
// function call.

const BRIDGE_SOURCE = "dnd-character-sheet-roll20-bridge";
const EXTENSION_SOURCE = "dnd-character-sheet-roll20-extension";

// Lets the sheet tell "extension not running on this page at all" apart
// from "running but not answering" (e.g. an older copy is loaded).
document.documentElement.dataset.csRoll20Bridge = chrome.runtime.getManifest().version;

function reply(type, requestId, extra) {
  window.postMessage({ source: EXTENSION_SOURCE, type, requestId, ...extra }, window.location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return; // ignore messages from iframes etc.

  const data = event.data;
  if (!data || data.source !== BRIDGE_SOURCE) return;

  switch (data.type) {
    case "ROLL":
      chrome.runtime.sendMessage({
        type: "FORWARD_ROLL",
        payload: {
          label: data.label,
          result: data.result,
          characterName: data.characterName,
        },
      });
      break;

    case "PING":
      reply("PONG", data.requestId, { ok: true, version: chrome.runtime.getManifest().version });
      break;

    case "SYNC_CHARACTER":
      chrome.runtime
        .sendMessage({ type: "SYNC_CHARACTER", payload: data.payload })
        .then((result) => reply("SYNC_RESULT", data.requestId, { result }))
        .catch((error) =>
          reply("SYNC_RESULT", data.requestId, {
            result: { ok: false, error: `Extension error: ${error && error.message ? error.message : error}` },
          })
        );
      break;

    case "HP_UPDATE":
      chrome.runtime.sendMessage({ type: "HP_UPDATE", payload: data.payload }).catch(() => undefined);
      break;
  }
});
