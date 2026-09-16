# Character Sheet → Roll20 Chat

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

## Known limitations

- Only forwards *from* the character sheet *to* Roll20 — it doesn't read
  anything back from Roll20 chat (that's the wild-magic extension's job).
- The chat line is plain text your extension composed client-side, not a
  native Roll20 `/roll` — like the wild-magic extension, this reports a
  roll that already happened in the browser rather than re-rolling it in
  Roll20's own dice engine.
- If several Roll20 tabs are open (e.g. two tabs on the same game), the
  roll is sent to all of them.

## Character sheet app
For the character sheet app itself, see [character-sheet](https://github.com/Sliwekok/character-sheet) 
