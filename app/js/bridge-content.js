// Runs on the character sheet page (see manifest.json "matches" -
// localhost/127.0.0.1 by default; widen it if your dev server runs
// somewhere else). Listens for the postMessage the sheet's page.tsx
// broadcasts from `recordRoll` on every "Roll ..." button press, and
// forwards it to the background service worker, which relays it to Roll20.
//
// This content script runs in an isolated world - it can't see the page's
// JS variables directly, which is exactly why the bridge is a postMessage
// (window messaging crosses that boundary by design) rather than a shared
// function call.

const BRIDGE_SOURCE = "dnd-character-sheet-roll20-bridge";

window.addEventListener("message", (event) => {
  if (event.source !== window) return; // ignore messages from iframes etc.

  const data = event.data;
  if (!data || data.source !== BRIDGE_SOURCE || data.type !== "ROLL") return;

  chrome.runtime.sendMessage({
    type: "FORWARD_ROLL",
    payload: {
      label: data.label,
      result: data.result,
      characterName: data.characterName,
    },
  });
});
