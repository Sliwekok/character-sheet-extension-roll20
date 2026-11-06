# Privacy policy - Character Sheet → Roll20

_Last updated: 6 November 2026_

Character Sheet → Roll20 ("the extension") is a hobby project by Sliwekok
(https://github.com/Sliwekok). It connects the Character Sheet web app to a
Roll20 game open in the same browser. This page explains what data it touches.

## Summary

The extension **does not collect, sell or send any data to the developer or to
any third party.** It has no servers, no analytics and no tracking. Everything
it handles stays in your own browser, apart from what you ask it to write into
your own Roll20 game.

## What the extension reads and why

| Data | Where it comes from | What it is used for |
| --- | --- | --- |
| Dice rolls (label, dice, total, character name, public/GM choice) | The Character Sheet page, when you roll | Posted as a chat message in the Roll20 game tab you have open |
| Character data (abilities, skills, HP, AC, attacks, spells, inventory, background...) | The Character Sheet page, when you press "Sync with Roll20" | Written to a character in the Roll20 game tab you have open |
| HP of synced characters | Your Roll20 game tab | Sent back to your open Character Sheet tab so HP stays the same on both |
| Roll20 game state needed for the above (character list, whether you are GM, campaign id) | Your Roll20 game tab | Finding/creating the right character and reporting errors |

The extension only runs on `app.roll20.net` and on the Character Sheet app's own
addresses listed in its manifest. It does not read any other website.

## What is stored, and where

Using Chrome's extension storage (`chrome.storage.local`) **on your computer only**:

- your settings (auto-forward on/off, chat style, Roll20 sheet type);
- a log of the last 50 forwarded rolls/syncs shown in the popup (you can clear it with "Clear log");
- links between Character Sheet characters and Roll20 characters (Roll20 character id and name, campaign id, last sync time), so later syncs update the same character;
- the version number of a downloaded update, until it is installed.

This data is never uploaded anywhere. Removing the extension deletes it.

The popup's **Inspect** button saves a Roll20 character's data as a file on
your computer; it is not sent anywhere.

## Data shared with third parties

None. Data you choose to sync is written into **your own Roll20 game**, where
Roll20's own privacy policy applies. Updates to the extension are delivered by
the Chrome Web Store.

## Contact

Questions or requests: open an issue at
https://github.com/Sliwekok/character-sheet-extension-roll20/issues

_Roll20 is a trademark of its respective owner. This extension is an independent
fan project and is not affiliated with or endorsed by Roll20._
