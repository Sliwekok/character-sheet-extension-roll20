// Turns a roll from the character sheet into the text typed into Roll20's
// chat box. Pure functions only (no chrome.* calls) so background.js can use
// them and they can be tested in plain Node.
//
// Two styles (popup "Chat style"):
//   "template" (default) - Roll20's built-in default roll template, which
//       every game has regardless of character sheet
//       (https://wiki.roll20.net/Text_Chat#Roll_Templates):
//         &{template:default} {{name=Longsword}} {{Character=Aragorn}}
//         {{Attack roll=[[14+5]]}} {{Dice=1d20 → 14 + 5}}
//       The total is an inline roll of the already-rolled numbers, so it
//       shows in Roll20's highlighted result box (hover = breakdown) but
//       can't change - the dice were rolled on the sheet, not re-rolled here.
//   "plain" - the original one-liner, "**Aragorn** — Longsword — Attack
//       roll: 14 + 5 = 19".
//
// Visibility "gm" prefixes either style with "/w gm ", so only the GM (and
// the sender) see it. Roll templates and inline rolls both work in whispers.

export const CHAT_FORMATS = ["template", "plain"];
export const DEFAULT_CHAT_FORMAT = "template";

/**
 * Mirrors describeDiceRoll() from the character sheet's utils/dice.ts, so
 * the plain style reads exactly like the result shown under the sheet's own
 * "Roll ..." buttons, e.g. "14 + 5 = 19", "[4, 6] + 3 = 13", "8".
 */
export function describeDiceRoll(result) {
  if (!result || !Array.isArray(result.rolls) || result.rolls.length === 0) {
    return String(result?.total ?? "");
  }
  const rollsText = result.rolls.length > 1 ? `[${result.rolls.join(", ")}]` : `${result.rolls[0]}`;
  const modifierText = result.modifier ? ` ${result.modifier >= 0 ? "+" : "-"} ${Math.abs(result.modifier)}` : "";
  return `${rollsText}${modifierText} = ${result.total}`;
}

/**
 * Neutralises everything Roll20 would otherwise parse inside sheet-provided
 * text (names, labels): braces would open/close template fields or start
 * @{attribute} / ?{query} / &{template} macros, brackets would start inline
 * rolls, "|" splits queries, and a newline would send a second chat line.
 */
function clean(text) {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[{[]/g, "(")
    .replace(/[}\]]/g, ")")
    .replace(/\|/g, "/")
    .trim();
}

/** A template field name additionally can't contain "=" (it ends the name). */
function cleanKey(text) {
  return clean(text).replace(/=/g, "-");
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * "Longsword — Attack roll" -> { title: "Longsword", subtitle: "Attack roll" }.
 * The sheet joins name and roll kind with " — " (weapons, spells) or " - "
 * (Short rest); single-part labels ("perception check") get "Result".
 */
export function splitLabel(label) {
  const text = clean(label);
  const match = text.match(/^(.+?)\s+[—–-]\s+(.+)$/);
  if (match) return { title: capitalize(match[1]), subtitle: capitalize(match[2]) };
  return { title: capitalize(text) || "Roll", subtitle: "Result" };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function isD20(result) {
  return typeof result?.formula === "string" && /^1d20\b/i.test(result.formula.trim());
}

function hasRolls(result) {
  return Array.isArray(result?.rolls) && result.rolls.length > 0;
}

/**
 * The die a d20 roll actually used. With advantage the sheet stores both
 * dice in `rolls` but only the higher one in `diceTotal`.
 */
function keptD20(result) {
  if (!isD20(result) || !hasRolls(result)) return null;
  return result.rolls.length === 1 ? result.rolls[0] : result.diceTotal;
}

/** The numbers inside [[ ]] - sums to `total`, shows the parts on hover. */
function inlineRollExpression(result) {
  const modifier = Number(result?.modifier) || 0;
  if (!hasRolls(result)) return `[[${Number(result?.total) || 0}]]`;
  const dice = sum(result.rolls) === result.diceTotal ? result.rolls.join("+") : String(result.diceTotal);
  const modifierText = modifier ? `${modifier > 0 ? "+" : "-"}${Math.abs(modifier)}` : "";
  return `[[${dice}${modifierText}]]`;
}

/** "1d20 → 14 + 5", "1d20 (advantage) → 8, **14** + 5", "2d6 → 4, 6 − 1". */
function diceBreakdown(result) {
  if (!hasRolls(result)) return null;
  const kept = keptD20(result);
  let keptMarked = false;
  const dice = result.rolls
    .map((value) => {
      if (result.rolls.length > 1 && kept !== null && value === kept && !keptMarked) {
        keptMarked = true;
        return `**${value}**`;
      }
      return String(value);
    })
    .join(", ");
  const modifier = Number(result.modifier) || 0;
  const modifierText = modifier ? ` ${modifier > 0 ? "+" : "−"} ${Math.abs(modifier)}` : "";
  const formula = clean(result.formula);
  return `${formula ? `${formula} → ` : ""}${dice}${modifierText}`;
}

/** Natural 20 / natural 1 call-out for d20 rolls, worded for attacks vs checks/saves. */
function naturalRow(result, subtitle) {
  const kept = keptD20(result);
  if (kept !== 20 && kept !== 1) return null;
  const isAttack = /attack/i.test(subtitle);
  if (kept === 20) return isAttack ? ["Critical hit", "**Natural 20!**"] : ["Natural 20", "**Rolled a 20!**"];
  return isAttack ? ["Fumble", "**Natural 1 — miss**"] : ["Natural 1", "**Rolled a 1**"];
}

function field(key, value) {
  return `{{${cleanKey(key)}=${value}}}`;
}

export function buildTemplateText(payload) {
  const { title, subtitle } = splitLabel(payload?.label);
  const result = payload?.result || {};
  const parts = ["&{template:default}", field("name", title)];
  if (payload?.characterName) parts.push(field("Character", clean(payload.characterName)));
  parts.push(field(subtitle, inlineRollExpression(result)));
  const breakdown = diceBreakdown(result);
  if (breakdown) parts.push(field("Dice", breakdown));
  const natural = naturalRow(result, subtitle);
  if (natural) parts.push(field(natural[0], natural[1]));
  return parts.join(" ");
}

export function buildPlainText(payload) {
  const who = payload?.characterName ? `**${clean(payload.characterName)}**` : "**Character Sheet**";
  return `${who} — ${clean(payload?.label)}: ${describeDiceRoll(payload?.result)}`;
}

/** The exact text sent to Roll20 chat. */
export function buildChatText(payload, format = DEFAULT_CHAT_FORMAT) {
  const body = format === "plain" ? buildPlainText(payload) : buildTemplateText(payload);
  return payload?.visibility === "gm" ? `/w gm ${body}` : body;
}

/** Short human line for the popup's activity log (the template source is unreadable there). */
export function buildLogText(payload) {
  const who = payload?.characterName ? `${payload.characterName} — ` : "";
  const gm = payload?.visibility === "gm" ? "[GM] " : "";
  return `${gm}${who}${payload?.label ?? "Roll"}: ${describeDiceRoll(payload?.result)}`;
}
