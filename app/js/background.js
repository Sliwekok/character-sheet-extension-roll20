// Background service worker: the hub between the character-sheet content
// script (bridge-content.js) and the Roll20 content script
// (roll20-content.js). Neither content script talks to the other directly -
// everything routes through here so a Roll20 tab doesn't need to exist yet
// when a roll happens, and so more than one Roll20 tab can be targeted.

const STORAGE_KEY_LOG = "forwardedRolls";
const STORAGE_KEY_ENABLED = "autoForwardEnabled";
const MAX_LOG = 50;

/**
 * Mirrors describeDiceRoll() from the character sheet's utils/dice.ts, so
 * the text that lands in Roll20 chat reads exactly like the result already
 * shown inline under the sheet's own "Roll ..." buttons, e.g.
 * "[14] + 5 = 19" or "[4, 6] + 3 = 13" or "8 = 8" for a flat, dice-less roll.
 */
function describeDiceRoll(result) {
  if (!result || !Array.isArray(result.rolls) || result.rolls.length === 0) {
    return String(result?.total ?? "");
  }
  const rollsText = result.rolls.length > 1 ? `[${result.rolls.join(", ")}]` : `${result.rolls[0]}`;
  const modifierText = result.modifier ? ` ${result.modifier >= 0 ? "+" : "-"} ${Math.abs(result.modifier)}` : "";
  return `${rollsText}${modifierText} = ${result.total}`;
}

function buildChatText(payload) {
  const who = payload.characterName ? `**${payload.characterName}**` : "**Character Sheet**";
  return `${who} — ${payload.label}: ${describeDiceRoll(payload.result)}`;
}

async function isAutoForwardEnabled() {
  const stored = await chrome.storage.local.get([STORAGE_KEY_ENABLED]);
  return stored[STORAGE_KEY_ENABLED] !== false; // default true when unset
}

async function appendLog(entry) {
  const stored = await chrome.storage.local.get([STORAGE_KEY_LOG]);
  const list = Array.isArray(stored[STORAGE_KEY_LOG]) ? stored[STORAGE_KEY_LOG] : [];
  list.unshift(entry);
  if (list.length > MAX_LOG) list.length = MAX_LOG;
  await chrome.storage.local.set({ [STORAGE_KEY_LOG]: list });
}

function flashBadge(ok) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? "#2e7d32" : "#c62828" });
  chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}

/** Sends `text` to every open Roll20 tab's chat box, logging the outcome. */
async function forwardToRoll20(payload) {
  const text = buildChatText(payload);
  const tabs = await chrome.tabs.query({ url: "*://app.roll20.net/*" });

  if (tabs.length === 0) {
    await appendLog({ ts: Date.now(), text, status: "failed", reason: "No Roll20 tab open" });
    flashBadge(false);
    return;
  }

  let anyOk = false;
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "SEND_TO_ROLL20", text });
      if (response?.ok) anyOk = true;
    } catch {
      // Content script not injected on this tab yet (e.g. still loading) -
      // other matching tabs, if any, still get a chance below.
    }
  }

  await appendLog({
    ts: Date.now(),
    text,
    status: anyOk ? "sent" : "failed",
    reason: anyOk ? undefined : "Roll20 chat box not found on any open tab",
  });
  flashBadge(anyOk);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FORWARD_ROLL") {
    (async () => {
      if (!(await isAutoForwardEnabled())) {
        sendResponse?.({ ok: false, skipped: true });
        return;
      }
      await forwardToRoll20(message.payload);
      sendResponse?.({ ok: true });
    })();
    return true; // keep the message channel open for the async response
  }

  if (message.type === "SEND_TEST_ROLL") {
    (async () => {
      const roll = Math.floor(Math.random() * 20) + 1;
      await forwardToRoll20({
        label: "Test roll",
        characterName: "Extension",
        result: { formula: "1d20", rolls: [roll], diceTotal: roll, modifier: 0, total: roll },
      });
      sendResponse?.({ ok: true });
    })();
    return true;
  }
});
