# Publikacja w Chrome Web Store - ściąga

Wszystko, co trzeba wkleić / wgrać w [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
Teksty listingu są po angielsku, bo cały interfejs wtyczki jest po angielsku.

## 0. Jednorazowo

1. Zarejestruj konto deweloperskie (jednorazowo 5 USD) i włącz weryfikację dwuetapową na koncie Google - bez 2FA nie da się publikować.
2. W zakładce **Account** uzupełnij e-mail kontaktowy i go zweryfikuj.

## 1. Paczka

```bash
node scripts/package.mjs                # -> dist/character-sheet-roll20-v<wersja>.zip
node scripts/package.mjs --no-localhost # wersja bez uprawnień do localhost/127.0.0.1
```

Skrypt sprawdza limity manifestu (opis ≤ 132 znaki, wersja, ikona 128 px, istnienie plików, brak `eval`/zdalnego kodu) i pakuje tylko `manifest.json`, `app/` i `assets/`.

- **Z localhostem** (domyślnie) - jedna instalacja ze Store'a działa i z produkcyjnym arkuszem, i z `npm run dev`. Recenzenci zwykle to akceptują, uzasadnienie jest niżej.
- **`--no-localhost`** - mniejsze uprawnienia, łatwiejsza recenzja; do developmentu zostaje kopia "Load unpacked".

> ⚠️ Nie trzymaj jednocześnie **włączonej** wersji ze Store'a i kopii "Load unpacked" - obie wstrzykną się do Roll20 i każdy rzut trafi na czat dwa razy. Wyłącz jedną w `chrome://extensions`.

**Kolejne wersje:** podbij `version` w `manifest.json` (musi być wyższa niż opublikowana), zbuduj ZIP, w dashboardzie *Package → Upload new package → Submit for review*. Użytkownicy dostaną aktualizację automatycznie (Chrome sprawdza co kilka godzin) albo od razu przyciskiem **Check for updates** w popupie.

## 2. Store listing

**Name** (z manifestu): `Character Sheet → Roll20`

**Summary** (z manifestu, 115/132):
> Sends rolls from your D&D character sheet to Roll20 chat and syncs characters into your game, with live two-way HP.

**Description:**

```
Play on Roll20 with your own D&D character sheet.

Character Sheet → Roll20 connects the Character Sheet web app to the Roll20 game you have open in the same browser:

• Rolls straight to chat - every weapon, spell, skill and save roll you make on the sheet is posted to Roll20 chat as a roll-template card (or a plain line). Pick public or GM-only per roll; natural 20s and 1s are marked.
• Full character sync - one click on "Sync with Roll20" creates or updates the character in your game: abilities, saves, skills, HP, AC, attacks, spells and slots, features, inventory, currency and background. Works with the "D&D 2024 by Roll20" sheet, with a bio-only fallback for other sheets.
• Live two-way HP - after a sync, HP changed on the sheet goes to Roll20, and HP changed in Roll20 (on its sheet or a token's bar) comes back to the sheet. Token bars are linked to HP and AC automatically.
• Activity log in the popup shows what was sent and why something failed.

How to use
1. Install the extension.
2. Open your Roll20 game (Launch Game) in one tab and your character in the Character Sheet app in another.
3. Roll on the sheet - it appears in Roll20 chat. Press "Sync with Roll20" to send the whole character (GM rights in the game are needed to create characters).

Privacy: nothing is collected or sent to the developer. Settings and the activity log stay in your browser; character data only goes to your own Roll20 game when you ask for it.

This is an independent fan project. It is not affiliated with or endorsed by Roll20. Roll20 is a trademark of its respective owner.
```

**Category:** Entertainment (ew. Games) · **Language:** English

**Graphic assets** (w tym folderze):
- Store icon 128×128: `../assets/icon128.png`
- Screenshots 1280×800: `screenshot-1-1280x800.png`, `screenshot-2-1280x800.png`
- Small promo tile 440×280: `promo-small-440x280.png`

**Official URL / Homepage:** adres aplikacji Character Sheet albo `https://github.com/Sliwekok/character-sheet-extension-roll20`
**Support URL:** `https://github.com/Sliwekok/character-sheet-extension-roll20/issues`

## 3. Privacy practices

**Single purpose:**
> Connects the user's Character Sheet web app to the Roll20 game open in the same browser: forwards dice rolls to Roll20 chat and syncs the character (with live HP) into that game.

**Permission justifications:**

| Uprawnienie | Uzasadnienie (do wklejenia) |
| --- | --- |
| `storage` | Stores the user's settings (auto-forward, chat style, Roll20 sheet type), a local log of the last 50 forwarded rolls shown in the popup, and links between sheet characters and Roll20 characters so re-syncs update the same character. Stored locally only. |
| Host `*://app.roll20.net/*` | Required to post the forwarded rolls into the Roll20 chat box and to create/update the synced character and read its HP in the user's open Roll20 game. |
| Host `dominiksliwek.duckdns.org` | The Character Sheet web app. A content script there receives roll/sync messages the page broadcasts and passes HP changes from Roll20 back to the page. |
| Host `localhost`, `127.0.0.1` (jeśli zostawiasz) | The same Character Sheet app when it is run locally (self-hosted / development). Only the bridge content script runs there. |

**Remote code:** *No, I am not using remote code.* (Wszystkie skrypty są w paczce; brak `eval`, brak zewnętrznych `<script>`.)

**Data usage** - najbezpieczniej zaznaczyć **Website content** (dane postaci i rzuty odczytywane ze strony arkusza są przekazywane do gry Roll20 użytkownika) i odhaczyć wszystkie trzy deklaracje:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:**
`https://github.com/Sliwekok/character-sheet-extension-roll20/blob/master/PRIVACY.md`
(repo musi być publiczne; po wypchnięciu `PRIVACY.md` na `master`).

## 4. Distribution

- **Visibility:** *Unlisted* - wtyczka nie pojawia się w wyszukiwarce, instaluje się z linku (gracze dostają link z zakładki About w aplikacji). *Public* - jeśli chcesz, żeby ktoś mógł ją znaleźć.
- **Regions:** All regions.

## 5. Po pierwszym uploadzie

Dashboard nada ID (32 litery, widoczne w URL elementu). Link do Store'a to:

```
https://chromewebstore.google.com/detail/<ID>
```

Wpisz go w aplikacji Character Sheet jako `NEXT_PUBLIC_EXTENSION_STORE_URL` (`.env.local` i zmienne środowiskowe hostingu) - zakładka About pokaże wtedy przycisk **Add to Chrome** zamiast instrukcji "Load unpacked".

Pierwsza recenzja trwa zwykle od kilku godzin do kilku dni.
