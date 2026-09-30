// Background service worker: the hub between the character-sheet content
// script (bridge-content.js) and the Roll20 content script
// (roll20-content.js). Neither content script talks to the other directly -
// everything routes through here so a Roll20 tab doesn't need to exist yet
// when a roll happens, and so more than one Roll20 tab can be targeted.

const STORAGE_KEY_LOG = "forwardedRolls";
const STORAGE_KEY_ENABLED = "autoForwardEnabled";
/** sheetCharacterId -> { roll20CharacterId, roll20Name, campaignId, syncedAt, profile } */
const STORAGE_KEY_LINKS = "characterLinks";
/** "auto" | profile key from roll20-profiles.js */
const STORAGE_KEY_PROFILE = "sheetProfile";
const MAX_LOG = 50;
const HP_DEBOUNCE_MS = 400;

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

// ---------------------------------------------------------------------------
// Character sync
// ---------------------------------------------------------------------------

async function getLinks() {
  const stored = await chrome.storage.local.get([STORAGE_KEY_LINKS]);
  return stored[STORAGE_KEY_LINKS] && typeof stored[STORAGE_KEY_LINKS] === "object" ? stored[STORAGE_KEY_LINKS] : {};
}

async function saveLink(sheetCharacterId, link) {
  const links = await getLinks();
  links[sheetCharacterId] = link;
  await chrome.storage.local.set({ [STORAGE_KEY_LINKS]: links });
}

async function getProfileSetting() {
  const stored = await chrome.storage.local.get([STORAGE_KEY_PROFILE]);
  return stored[STORAGE_KEY_PROFILE] || "auto";
}

/**
 * The one Roll20 game tab a sync goes to - character writes must not be
 * repeated per tab (two tabs would create two characters). Picks the most
 * recently used tab that actually has the game loaded.
 */
async function findGameTab() {
  const tabs = (await chrome.tabs.query({ url: "*://app.roll20.net/*" }))
    .filter((tab) => tab.id)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  if (tabs.length === 0) return { error: "No Roll20 tab open - open your game (Launch Game) in this browser." };
  let lastError = "Roll20 game isn't loaded yet - wait for the tabletop to finish loading.";
  for (const tab of tabs) {
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: "R20_STATUS" });
      if (status && status.loaded) return { tab, status };
      if (status && status.error) lastError = status.error;
    } catch {
      lastError = "Reload the Roll20 tab once so the extension can attach to it.";
    }
  }
  return { error: lastError };
}

/** The saved link for this character, but only if it belongs to the game that's open now. */
function linkFor(links, sheetCharacterId, campaignId) {
  const link = links[sheetCharacterId];
  if (!link) return null;
  if (link.campaignId && campaignId && link.campaignId !== campaignId) return null;
  return link;
}

async function syncCharacter(exportData) {
  const found = await findGameTab();
  if (found.error) {
    await appendLog({ ts: Date.now(), text: `Sync ${exportData?.name ?? "character"}`, status: "failed", reason: found.error });
    flashBadge(false);
    return { ok: false, error: found.error };
  }
  const { tab, status } = found;
  const links = await getLinks();
  const profile = await getProfileSetting();
  const link = linkFor(links, exportData.sheetCharacterId, status.campaignId);

  let result;
  try {
    result = await chrome.tabs.sendMessage(tab.id, { type: "R20_SYNC", payload: { exportData, link, profile } });
  } catch (error) {
    result = { ok: false, error: `Couldn't reach the Roll20 tab: ${error && error.message ? error.message : error}` };
  }
  result = result || { ok: false, error: "No answer from the Roll20 tab." };

  if (result.ok) {
    await saveLink(exportData.sheetCharacterId, {
      roll20CharacterId: result.roll20CharacterId,
      roll20Name: result.roll20Name,
      campaignId: result.campaignId || status.campaignId || null,
      profile: result.profile,
      syncedAt: Date.now(),
    });
  }
  await appendLog({
    ts: Date.now(),
    text: `Sync ${exportData.name}${result.ok ? ` - ${result.created ? "created" : "updated"}${result.summary ? ` (${result.summary})` : ""}` : ""}`,
    status: result.ok ? "sent" : "failed",
    reason: result.ok ? undefined : result.error,
  });
  flashBadge(Boolean(result.ok));
  return result;
}

// HP edits can arrive in bursts (typing "-12", clicking +/-), so only the
// latest value per character is sent, a moment after the last change.
const pendingHp = new Map();

function queueHpUpdate(update) {
  const key = update.sheetCharacterId;
  const pending = pendingHp.get(key);
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    pendingHp.delete(key);
    sendHpUpdate(update);
  }, HP_DEBOUNCE_MS);
  pendingHp.set(key, { timer, update });
}

async function sendHpUpdate(update) {
  const text = `HP ${update.name}: ${update.current}/${update.max}`;
  const found = await findGameTab();
  if (found.error) {
    await appendLog({ ts: Date.now(), text, status: "failed", reason: found.error });
    return;
  }
  const links = await getLinks();
  const link = linkFor(links, update.sheetCharacterId, found.status.campaignId) ||
    (update.roll20CharacterId ? { roll20CharacterId: update.roll20CharacterId } : null);
  const profile = await getProfileSetting();
  let result;
  try {
    result = await chrome.tabs.sendMessage(found.tab.id, { type: "R20_HP", payload: { update, link, profile } });
  } catch (error) {
    result = { ok: false, error: String(error && error.message ? error.message : error) };
  }
  await appendLog({ ts: Date.now(), text, status: result && result.ok ? "sent" : "failed", reason: result && result.ok ? undefined : result && result.error });
  flashBadge(Boolean(result && result.ok));
}

async function inspectRoll20(name) {
  const found = await findGameTab();
  if (found.error) return { ok: false, error: found.error };
  try {
    return await chrome.tabs.sendMessage(found.tab.id, { type: "R20_INSPECT", payload: { name } });
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
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

  if (message.type === "SYNC_CHARACTER") {
    syncCharacter(message.payload).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    );
    return true;
  }

  if (message.type === "HP_UPDATE") {
    if (message.payload && message.payload.sheetCharacterId) queueHpUpdate(message.payload);
    sendResponse?.({ ok: true, queued: true });
    return false;
  }

  if (message.type === "INSPECT_ROLL20") {
    inspectRoll20(message.name).then(sendResponse);
    return true;
  }

  if (message.type === "GET_ROLL20_STATUS") {
    (async () => {
      const found = await findGameTab();
      const links = await getLinks();
      sendResponse({ ...(found.status || { loaded: false, error: found.error }), links, profile: await getProfileSetting() });
    })();
    return true;
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
