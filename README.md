# Character Sheet → Roll20

A Chrome extension (Manifest V3, no build step — plain JS/HTML/CSS, same
style as the `roll20-wild-magic-ext`/`roll20-move-assets` extensions) that
watches your D&D character sheet app for rolls (weapon attacks/damage,
spell attacks/effects, skill checks — anything that already feeds the
sheet's Roll History widget) and forwards each one into whichever Roll20
tab you have open, as a plain chat line, e.g.:

```
**Aragorn** — Longsword — Attack roll: [14] + 5 = 19
```

## How it works

1. **`app/js/bridge-content.js`** runs on the character sheet page
   (`http://localhost/*` / `http://127.0.0.1/*` by default — see "If your
   dev server runs somewhere else" below). It listens for a `postMessage`
   the sheet broadcasts on every roll and relays it to the background
   worker.
2. **`app/js/background.js`** is the hub: it formats the chat text, finds
   every open `app.roll20.net` tab, and forwards the roll to each one. It
   also keeps a small rolling log in `chrome.storage.local` for the popup,
   and flashes the toolbar icon green/red so you get feedback without
   opening the popup.
3. **`app/js/roll20-content.js`** runs on `app.roll20.net`. It types the
   text into Roll20's chat box (`#textchat-input textarea`) and clicks the
   real send button (`#chatSendBtn`) — the same DOM hooks the wild-magic
   extension uses.

If no Roll20 tab is open, or the chat box hasn't mounted yet, the roll is
logged as "failed" in the popup instead of silently disappearing.

## Installing

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (the one with
   `manifest.json` in it).
3. Click the extension's icon to open the popup — it shows whether a
   Roll20 tab is currently detected, an **auto-forward** toggle, a **Send
   test roll** button (forwards a fake roll so you can confirm the Roll20
   side works without touching the character sheet), and a log of recent
   attempts.

After editing any file, reload the extension from `chrome://extensions`
(the background worker and content scripts aren't hot-reloaded).

## The character-sheet-side change

For the auto-capture to have anything to listen for, `recordRoll` in
`src/app/character/[id]/page.tsx` now also does:

```ts
window.postMessage(
  {
    source: "dnd-character-sheet-roll20-bridge",
    type: "ROLL",
    label,
    result,
    characterName: character?.name,
  },
  window.location.origin
);
```

This is a no-op with the extension not installed — `postMessage` with
nothing listening just goes nowhere. Nothing else about the sheet changed;
every existing "Roll ..." button already fed `recordRoll`, so this reaches
every one of them for free.

## If your dev server runs somewhere else

`manifest.json`'s `content_scripts`/`host_permissions` match
`http://localhost/*` and `http://127.0.0.1/*` (any port — Chrome match
patterns treat an omitted port as "any port"). If the sheet is served from
a different host — a `.test` domain via XAMPP's Apache vhost, for
instance — add that origin to both the `matches` array in the second
`content_scripts` entry and to `host_permissions`, then reload the
extension.

## Character sync ("Sync with Roll20")

The character sheet page has a **Sync with Roll20** button in its header.
Pressing it sends the whole character to the Roll20 game open in another tab:
the first sync creates the Roll20 character, later syncs update that same
character. After a character has been synced once, **every HP change on the
sheet is pushed to Roll20 automatically** (also after a page reload). Nothing
else streams - press the button again to push other changes.

You need to be the GM of the game (Roll20 only lets GMs create characters),
and the game itself must be open (Launch Game), not just the campaign page.

### How it works

1. The sheet builds a Roll20-agnostic export of the character (every value
   already final - see the app's `src/utils/roll20/roll20Export.ts`) and
   posts it as `SYNC_CHARACTER`; HP changes go as `HP_UPDATE`.
2. `bridge-content.js` relays both to `background.js`, which picks **one**
   Roll20 game tab (the most recently used one with the game loaded - never
   all of them, or you'd get duplicate characters), and remembers which
   Roll20 character belongs to which sheet character (`characterLinks` in
   `chrome.storage.local`, per campaign). HP updates are debounced so a burst
   of edits sends only the final value.
3. `roll20-content.js` passes the request into the Roll20 page itself, where
   `roll20-page.js` runs in the page's own context (`"world": "MAIN"`) and
   uses Roll20's in-memory game objects (`window.Campaign`) to find the
   character (by saved id, else by name), create it if missing, and write
   attributes, repeating rows and the Bio & Info tab.
4. **`roll20-profiles.js` is the only file that knows Roll20 sheet field
   names.** Each profile turns the export into attributes / repeating rows /
   bio for one sheet template. Repeating rows the extension creates carry a
   hidden `cs_sync_key` field, so re-syncs update or remove only those rows
   and never touch rows you added by hand in Roll20.

### Sheet templates

| Popup setting | What's written |
|---|---|
| Auto-detect | Picks a profile from the game's settings |
| D&D 2024 by Roll20 | The real sheet: classes/levels, ability scores, max + current HP, AC, speed, saves/skills/weapon/armor/tool proficiencies, languages, features & traits, weapons as items with attacks and damage, spellcasting (ability, slots, spells with attack/save/damage), armor/gear/magic items, coins, inspiration, conditions - plus the full write-up in **Bio & Info**. See "The D&D 2024 sheet" below. |
| Bio only | Full character in **Bio & Info**, HP in `hp` - works with any sheet |

### The D&D 2024 sheet

The 2024 sheet has no plain attributes. The whole character is one `store`
object, and everything mechanical in it is a list of typed entries
("integrants") - an ability score entry, a class level entry, an attack with
a damage entry under it, and so on - from which the sheet computes the final
numbers, exactly as for a character made with Roll20's own builder.
`roll20-dnd2024.js` builds those entries from the app's export:

- Values are written as the app computed them (e.g. each ability as one
  "Set Base" with the final score, AC as a fixed value, max HP as one fixed
  entry), so Roll20 shows the same numbers as your sheet. After writing, the
  extension reads the values back from Roll20 and reports any difference
  under the Sync button.
- Current HP (sync and live stream) goes through the sheet's own HP setter
  when Roll20 exposes one. Otherwise the extension learns where the sheet
  keeps it from this game's own characters: for characters below max HP,
  Roll20's summary (`custom_meta1`) says their real current HP, and the value
  in their store that matches it (or the damage taken) is the spot. Every
  write is read back from Roll20; a wrong guess is reported and re-learned.
- Token bars: every token of a synced character (and its default token) gets
  **bar 1 linked to HP** (current/max) and **bar 2 linked to AC**. If the
  character has no token yet, drag it onto the map and sync again.
- Every entry the sync writes is tagged (`builderIteration: "cs-sync"`, stable
  ids), so a re-sync replaces exactly those and leaves the sheet's defaults
  and anything you added by hand alone.
- A character that was built with Roll20's own builder is never overwritten;
  the sync refuses and asks you to rename or delete it first.
- `roll20-dnd2024-template.js` is a blank store (sheet version 25) used for
  characters that don't have one yet.

Known gaps: magic/fighting-style to-hit bonuses on weapons aren't added (damage
is exact); class features are text only (no resources or automation); temp HP,
XP and death saves aren't synced.

### Mapping a sheet's fields (Inspect)

The popup's **Inspect** button saves one Roll20 character's raw data as
`roll20-dump.json` (read-only - nothing in Roll20 changes). Fill a test
character in on the Roll20 sheet by hand, inspect it, and the dump shows the
exact field names a profile needs.

### Caveats

- This uses Roll20's internal page objects, not a public API. A Roll20 update
  can break it; failures show up as a readable error under the Sync button
  and in the popup log rather than half-written characters.
- Temp HP, XP and class resources aren't stored by the character sheet app,
  so they can't be synced.

## Known limitations

- Only sends *from* the character sheet *to* Roll20 — nothing is read back
  (HP changed on a Roll20 token doesn't flow back to the sheet).
- The chat line is plain text your extension composed client-side, not a
  native Roll20 `/roll` — like the wild-magic extension, this reports a
  roll that already happened in the browser rather than re-rolling it in
  Roll20's own dice engine.
- If several Roll20 tabs are open (e.g. two tabs on the same game), the
  roll is sent to all of them.

## Character sheet app
For the character sheet app itself, see [character-sheet](https://github.com/Sliwekok/character-sheet) 
