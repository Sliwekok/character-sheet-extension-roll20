// Runs in Roll20's own page context (manifest "world": "MAIN") so it can use
// Roll20's in-memory game objects (window.Campaign - the same Backbone models
// the tabletop itself uses). Content scripts can't see those, so
// roll20-content.js (isolated world) relays requests here with
// window.postMessage and waits for the reply.
//
// This is not a public Roll20 API. Everything is defensive: if Roll20 changes
// its internals, requests fail with a readable error instead of half-writing.

(() => {
  if (window.__csRoll20PageLoaded) return;
  window.__csRoll20PageLoaded = true;

  const FROM_ISOLATED = "cs-roll20-isolated";
  const FROM_PAGE = "cs-roll20-page";
  const SUPPORTED_EXPORT_VERSION = 1;
  /** Hidden field stamped on every repeating row this extension creates, so re-syncs update/remove only its own rows. */
  const SYNC_KEY_FIELD = "cs_sync_key";

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function campaign() {
    const c = window.Campaign || (window.d20 && window.d20.Campaign);
    if (!c || !c.characters) {
      throw new Error("Roll20 game isn't loaded in this tab - open the game itself (Launch Game), not the campaign page.");
    }
    return c;
  }

  // --- Roll20's repeating-row id generator (same algorithm the sheets use) ---
  const generateRowID = (() => {
    const chars = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
    let lastTime = 0;
    const lastRandom = [];
    return () => {
      let now = Date.now();
      const duplicate = now === lastTime;
      lastTime = now;
      const timeChars = new Array(8);
      for (let i = 7; i >= 0; i--) {
        timeChars[i] = chars.charAt(now % 64);
        now = Math.floor(now / 64);
      }
      let id = timeChars.join("");
      if (duplicate) {
        let i;
        for (i = 11; i >= 0 && lastRandom[i] === 63; i--) lastRandom[i] = 0;
        lastRandom[i]++;
      } else {
        for (let i = 0; i < 12; i++) lastRandom[i] = Math.floor(Math.random() * 64);
      }
      for (let i = 0; i < 12; i++) id += chars.charAt(lastRandom[i]);
      return id.replace(/_/g, "Z");
    };
  })();

  // --- characters -------------------------------------------------------------

  function findCharacter({ roll20CharacterId, name }) {
    const chars = campaign().characters;
    if (roll20CharacterId) {
      const byId = chars.get(roll20CharacterId);
      if (byId) return byId;
    }
    if (!name) return null;
    const wanted = name.trim().toLowerCase();
    const matches = chars.models.filter((c) => String(c.get("name") || "").trim().toLowerCase() === wanted);
    if (matches.length > 1) {
      throw new Error(`There are ${matches.length} Roll20 characters named "${name}" - rename or delete the extras, then sync again.`);
    }
    return matches[0] || null;
  }

  async function createCharacter(name, sheetName) {
    const chars = campaign().characters;
    if (typeof chars.create !== "function") throw new Error("Can't create characters here (Roll20's character list has no create()).");
    // Same fields Roll20's own "new character" uses (characterSheet.createCharacter):
    // the sheet template name, then journal folder + sheet defaults once saved.
    const attrs = { name, inplayerjournals: "", controlledby: "", ...(sheetName ? { charactersheetname: sheetName } : {}) };
    const character = chars.create(attrs, {
      success: (model) => {
        try {
          const journal = model.d20 && model.d20.journal;
          if (journal && journal.addItemToFolderStructure) journal.addItemToFolderStructure(model.id);
          if (journal && journal.applyCharacterSheetDefaults) journal.applyCharacterSheetDefaults(model);
        } catch {
          // Cosmetic only (journal placement) - the character itself exists.
        }
      },
    });
    // Firebase-backed models get their id/attribs collection straight away,
    // but give Roll20 a moment to register the new journal entry.
    for (let i = 0; i < 20 && !(character && character.id && character.attribs); i++) await wait(100);
    if (!character || !character.id || !character.attribs) throw new Error("Roll20 didn't finish creating the character.");
    return character;
  }

  /** Attributes load lazily; fetch and wait until the count stops changing. */
  async function loadAttribs(character) {
    if (!character.attribs) throw new Error("This character has no attribute list (unexpected Roll20 internals).");
    try {
      character.attribs.fetch(character.attribs);
    } catch {
      // Already loaded, or fetch not needed on this Roll20 version.
    }
    let last = -1;
    for (let i = 0; i < 25; i++) {
      const count = character.attribs.length;
      if (count === last && i >= 3) break;
      last = count;
      await wait(120);
    }
    return character.attribs;
  }

  function attrIndex(character) {
    const map = new Map();
    for (const attr of character.attribs.models) map.set(String(attr.get("name")), attr);
    return map;
  }

  const str = (value) => (value === undefined || value === null ? "" : String(value));

  /** Create or update one attribute. Returns true if anything changed. */
  function upsertAttr(character, index, { name, current, max }) {
    const existing = index.get(name);
    const next = { current: str(current) };
    if (max !== undefined) next.max = str(max);
    if (existing) {
      const same = str(existing.get("current")) === next.current && (next.max === undefined || str(existing.get("max")) === next.max);
      if (same) return false;
      existing.save(next);
      return true;
    }
    const created = character.attribs.create({ name, ...next });
    index.set(name, created);
    return true;
  }

  /**
   * Repeating rows, keyed by a stable `key` per row (e.g. "attack:Longsword").
   * Rows this extension made earlier are found through their cs_sync_key
   * field and updated; ones whose key is gone are removed. Rows the player
   * added by hand never carry the field, so they are never touched.
   */
  function syncRepeating(character, index, section, rows, counters) {
    const prefix = `repeating_${section}_`;
    const existingRows = new Map(); // key -> rowId
    for (const [name, attr] of index) {
      if (!name.startsWith(prefix) || !name.endsWith(`_${SYNC_KEY_FIELD}`)) continue;
      const rowId = name.slice(prefix.length, name.length - SYNC_KEY_FIELD.length - 1);
      existingRows.set(str(attr.get("current")), rowId);
    }

    const keep = new Set();
    const seenKeys = new Map();
    for (const original of rows) {
      // Two identical items (e.g. two Daggers) would share a key - number the repeats.
      const count = (seenKeys.get(original.key) || 0) + 1;
      seenKeys.set(original.key, count);
      const row = count > 1 ? { ...original, key: `${original.key}#${count}` } : original;
      let rowId = existingRows.get(row.key);
      if (!rowId) {
        rowId = generateRowID();
        counters.rowsCreated++;
      }
      keep.add(rowId);
      upsertAttr(character, index, { name: `${prefix}${rowId}_${SYNC_KEY_FIELD}`, current: row.key });
      for (const [field, value] of Object.entries(row.fields)) {
        const spec = value && typeof value === "object" ? value : { current: value };
        if (upsertAttr(character, index, { name: `${prefix}${rowId}_${field}`, current: spec.current, max: spec.max })) counters.fields++;
      }
    }

    for (const [, rowId] of existingRows) {
      if (keep.has(rowId)) continue;
      const rowPrefix = `${prefix}${rowId}_`;
      for (const [name, attr] of [...index]) {
        if (!name.startsWith(rowPrefix)) continue;
        attr.destroy();
        index.delete(name);
      }
      counters.rowsRemoved++;
    }
  }

  function setBio(character, html) {
    if (typeof character.updateBlobs === "function") {
      character.updateBlobs({ bio: html });
      return true;
    }
    return false;
  }

  // --- sheet detection --------------------------------------------------------

  const SHEET_NAME_TO_PROFILE = { dnd2024byroll20: "dnd2024" };

  /**
   * Which sheet template this game uses; the popup can override it. Jumpgate
   * characters carry `charactersheetname` (e.g. "dnd2024byroll20") - the
   * most common value across the journal wins.
   */
  function detectProfile() {
    const counts = new Map();
    for (const ch of campaign().characters.models) {
      const sheet = ch.get("charactersheetname");
      if (sheet) counts.set(sheet, (counts.get(sheet) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && SHEET_NAME_TO_PROFILE[top[0]]) return SHEET_NAME_TO_PROFILE[top[0]];
    const attrs = campaign().attributes || {};
    const hay = Object.entries(attrs)
      .filter(([, v]) => typeof v === "string" && v.length < 300)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
      .toLowerCase();
    if (/2024|dnd2024|dnd_2024|beacon/.test(hay)) return "dnd2024";
    return "bio";
  }

  function resolveProfile(requested) {
    const { profiles } = window.__csRoll20Profiles || {};
    if (!profiles) throw new Error("Profile table didn't load (roll20-profiles.js).");
    const key = requested && requested !== "auto" ? requested : detectProfile();
    const profile = profiles[key];
    if (!profile) throw new Error(`Unknown sheet profile "${key}".`);
    return { key, profile };
  }

  // --- requests ---------------------------------------------------------------

  // --- D&D 2024 (advanced/Beacon sheet) ---------------------------------------

  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), ms))]);

  /** A number out of whatever getComputed returns (42, "42", {current: 42}, {value: 42}...). */
  function toNumber(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    if (typeof value === "object") {
      for (const key of ["current", "value", "total", "score"]) if (key in value) return toNumber(value[key]);
    }
    return NaN;
  }

  function relayFor(character) {
    const relay = character.characterSheet && character.characterSheet.headlessRelay;
    return relay || null;
  }

  async function getComputed(character, property) {
    const relay = relayFor(character);
    if (!relay || typeof relay.getComputed !== "function") return undefined;
    try {
      const value = await withTimeout(relay.getComputed({ characterId: character.id, property }), 3000);
      return value && value.__timeout ? undefined : value;
    } catch {
      return undefined;
    }
  }

  /** The sheet's own HP setter, if this Roll20 version exposes one; verified by reading the value back. */
  async function trySetterHp(character, current) {
    const relay = relayFor(character);
    if (!relay) return false;
    const setters = [relay.setComputed, relay.methods && relay.methods.setComputed].filter((fn) => typeof fn === "function");
    const attempts = [
      (fn) => fn.call(relay, { characterId: character.id, property: "hp", value: current }),
      (fn) => fn.call(relay, { characterId: character.id, property: "hp", args: [current] }),
      (fn) => fn.call(relay, { characterId: character.id, property: "hp_current", value: current }),
    ];
    for (const fn of setters) {
      for (const attempt of attempts) {
        try {
          await withTimeout(Promise.resolve(attempt(fn)), 3000);
        } catch {
          continue;
        }
        await wait(300);
        if (toNumber(await getComputed(character, "hp")) === Number(current)) return true;
      }
    }
    return false;
  }

  /**
   * Where does the 2024 sheet keep current HP? Learned from this game's own
   * characters: for hurt ones, Roll20's summary (custom_meta1) says the real
   * current HP, and the number in their store that matches it (or the damage
   * taken) is the spot. Cached for the rest of the page session.
   */
  async function learnHpShapeFromGame(excludeId) {
    if (window.__csHpShape) return window.__csHpShape;
    const engine = window.__csDnd2024;
    const hurt = campaign()
      .characters.models.filter((c) => c.id !== excludeId && c.get("charactersheetname") === "dnd2024byroll20")
      .map((c) => ({ c, hp: engine.readMetaHp(c.get("custom_meta1")) }))
      .filter(({ hp }) => hp && hp.current > 0 && hp.current < hp.max)
      .slice(0, 15);
    const samples = [];
    for (const { c, hp } of hurt) {
      try {
        await loadAttribs(c);
        const store = c.attribs.models.find((a) => a.get("name") === "store");
        const value = store && store.get("current");
        if (value && typeof value === "object") samples.push({ store: value, hp });
      } catch {
        // skip characters whose data won't load
      }
    }
    const shape = engine.learnHpShape(samples);
    // One sample is a guess; with several, require at least two to agree.
    if (shape && (samples.length === 1 || shape.agreedBy >= 2)) window.__csHpShape = shape;
    return window.__csHpShape || null;
  }

  async function storeHp(character, current, max, sheetCharacterId, excludeId) {
    const shape = await learnHpShapeFromGame(excludeId);
    if (!shape) return { ok: false, error: "Couldn't work out where the 2024 sheet keeps current HP - it needs at least one hurt (below max HP) 2024 character in this game to learn from." };
    await loadAttribs(character);
    const attr = character.attribs.models.find((a) => a.get("name") === "store");
    const store = attr && attr.get("current");
    if (!store || typeof store !== "object") return { ok: false, error: "This character has no 2024 sheet data yet - press Sync with Roll20 first." };
    // "Damage taken" is relative to the max Roll20 itself computes, which is the one that counts here.
    const rollMax = toNumber(await getComputed(character, "hp_max"));
    const effectiveMax = Number.isNaN(rollMax) ? max : rollMax;
    attr.save({ current: window.__csDnd2024.applyHp(store, shape, current, effectiveMax, sheetCharacterId) });
    await wait(800);
    const readBack = toNumber(await getComputed(character, "hp"));
    const verified = !Number.isNaN(readBack) ? readBack === Number(current) : null;
    if (verified === false) {
      window.__csHpShape = null; // wrong guess - re-learn next time
      return { ok: false, error: `Current HP was written but Roll20 shows ${readBack} instead of ${current}.` };
    }
    return { ok: true, via: "store", verified };
  }

  /**
   * Finds, in other 2024 characters of this game, the store section holding
   * `currentHP` (it only exists once a character's HP has been changed).
   * Characters made by this extension are skipped. Cached per page session.
   */
  async function learnHpSectionFromGame(excludeId) {
    if (window.__csHpSection !== undefined) return window.__csHpSection;
    const engine = window.__csDnd2024;
    const tally = new Map();
    let scanned = 0;
    // Characters whose HP was ever set (summary shows current > 0) are the ones that have the section.
    const hpOf = (c) => {
      const hp = engine.readMetaHp(c.get("custom_meta1"));
      return hp ? hp.current : 0;
    };
    const candidates = campaign()
      .characters.models.filter((c) => c.id !== excludeId && c.get("charactersheetname") === "dnd2024byroll20")
      .sort((a, b) => (hpOf(b) > 0) - (hpOf(a) > 0));
    for (const c of candidates) {
      if (scanned >= 80 || [...tally.values()].some((t) => t.count >= 3)) break;
      try {
        await loadAttribs(c);
      } catch {
        continue;
      }
      const attr = c.attribs.models.find((a) => a.get("name") === "store");
      const store = attr && attr.get("current");
      if (!store || typeof store !== "object") continue;
      scanned++;
      const ints = (store.integrants && store.integrants.integrants) || {};
      if (Object.values(ints).some((e) => e && e.builderIteration === engine.SYNC_TAG)) continue;
      const section = engine.describeHpSection(store);
      if (!section) continue;
      const entry = tally.get(section.key) || { section, count: 0 };
      entry.count++;
      tally.set(section.key, entry);
    }
    const best = [...tally.values()].sort((a, b) => b.count - a.count)[0];
    window.__csHpSection = best ? best.section : null;
    window.__csHpSectionInfo = best ? `${best.section.key} (seen in ${best.count} of ${scanned} characters)` : `not found in ${scanned} characters`;
    return window.__csHpSection;
  }

  /** Writes currentHP straight into the store section the sheet reads it from. */
  async function sectionHp(character, current, sheetCharacterId) {
    const section = await learnHpSectionFromGame(character.id);
    if (!section) return null;
    await loadAttribs(character);
    const attr = character.attribs.models.find((a) => a.get("name") === "store");
    const store = attr && attr.get("current");
    if (!store || typeof store !== "object") return { ok: false, error: "This character has no 2024 sheet data yet - press Sync with Roll20 first." };
    attr.save({ current: window.__csDnd2024.writeCurrentHp(store, section, current, sheetCharacterId) });
    await wait(800);
    const readBack = toNumber(await getComputed(character, "hp"));
    if (!Number.isNaN(readBack) && readBack !== Number(current)) {
      return { ok: false, error: `Current HP was written but Roll20 shows ${readBack} instead of ${current}.` };
    }
    return { ok: true, via: "section", verified: Number.isNaN(readBack) ? null : true };
  }

  /**
   * Current HP on the 2024 sheet, in order: the `currentHP` section learned
   * from the game's other characters (no sheet code involved), the sheet's own
   * setter, then the value-matching fallback.
   */
  async function setCurrentHp2024(character, current, max, sheetCharacterId) {
    const direct = await sectionHp(character, current, sheetCharacterId);
    if (direct && direct.ok) return direct;
    if (window.__csHpVia !== "store" && (await trySetterHp(character, current))) {
      window.__csHpVia = "setter";
      return { ok: true, via: "setter", verified: true };
    }
    const result = await storeHp(character, current, max, sheetCharacterId, character.id);
    if (result.ok) window.__csHpVia = "store";
    return result;
  }

  /**
   * Links every token of this character (on loaded pages) - and its default
   * token - so bar 1 shows HP and bar 2 shows AC. On advanced sheets a bar
   * link is the sheet's computed property name, as-is: Roll20 passes it
   * straight to the sheet ("sheetattr_hp" fails with "Unable to find
   * property"). "hp" gives current/max.
   */
  async function linkTokenBars(character) {
    const links = { bar1_link: "hp", bar2_link: "ac" };
    let tokens = 0;
    const pages = campaign().pages;
    const pageList = pages ? (pages.models || []) : [];
    for (const page of pageList) {
      const graphics = page.thegraphics && page.thegraphics.models;
      if (!graphics) continue;
      for (const g of graphics) {
        if (g.get("represents") !== character.id) continue;
        if (g.get("bar1_link") !== links.bar1_link || g.get("bar2_link") !== links.bar2_link) g.save(links);
        tokens++;
      }
    }
    let defaultToken = false;
    try {
      if (typeof character._getLatestBlob === "function") {
        const raw = await withTimeout(Promise.resolve(character._getLatestBlob("defaulttoken")), 3000);
        const token = raw && typeof raw === "string" && raw.trim().startsWith("{") ? JSON.parse(raw) : null;
        if (token) {
          if (token.bar1_link !== links.bar1_link || token.bar2_link !== links.bar2_link) {
            await character.updateBlobs({ defaulttoken: JSON.stringify({ ...token, ...links, represents: character.id }) });
          }
          defaultToken = true;
        }
      }
    } catch {
      // No default token yet - the bars get linked the next time a sync finds a token on the map.
    }
    return { tokens, defaultToken };
  }

  function refreshTokens(character) {
    try {
      if (typeof character.updateTokensForAdvancedSheets === "function") character.updateTokensForAdvancedSheets();
    } catch {
      // Token bars catch up the next time Roll20 refreshes them.
    }
  }

  async function saveObjectAttr(character, name, value, onlyIfMissing = false) {
    const existing = character.attribs.models.find((a) => a.get("name") === name);
    if (existing) {
      if (!onlyIfMissing) existing.save({ current: value });
      return existing;
    }
    return character.attribs.create({ name, current: value, max: "" });
  }

  /** Compares what the sheet now computes with what the app exported; mismatches become warnings. */
  async function verify2024(character, exp) {
    const checks = [
      ...Object.entries(exp.abilities).map(([key, a]) => [key, a.score, key[0].toUpperCase() + key.slice(1)]),
      ["ac", exp.armorClass, "AC"],
      ["hp_max", exp.hp.max, "Max HP"],
    ];
    const mismatches = [];
    let checked = 0;
    for (const [property, expected, label] of checks) {
      const actual = toNumber(await getComputed(character, property));
      if (Number.isNaN(actual)) continue;
      checked++;
      if (actual !== expected) mismatches.push(`${label}: Roll20 shows ${actual}, sheet says ${expected}`);
    }
    return { checked, mismatches };
  }

  async function sync2024(character, exportData, { created, linked }) {
    const engine = window.__csDnd2024;
    const template = window.__csDnd2024Template;
    if (!engine || !template) throw new Error("The D&D 2024 writer didn't load (roll20-dnd2024.js).");

    await loadAttribs(character);
    const storeAttr = character.attribs.models.find((a) => a.get("name") === "store");
    const currentStore = storeAttr ? storeAttr.get("current") : null;
    const hasStore = currentStore && typeof currentStore === "object" && currentStore.integrants;
    if (hasStore && !created && !linked && engine.hasBuilderContent(currentStore)) {
      throw new Error(
        `"${exportData.name}" in Roll20 was built with Roll20's own character builder - not overwriting it. Rename or delete it there, then sync again.`
      );
    }

    const result = engine.buildStore(exportData, hasStore ? currentStore : null, template.store);
    await saveObjectAttr(character, "store", result.store);
    await saveObjectAttr(character, "builder", { hasCompletedOnce: true, isInProgress: false }, true);
    await saveObjectAttr(character, "sheetVersion", template.sheetVersion, true);
    await saveObjectAttr(character, "appState", "sheet", true);

    const warnings = [...result.notes];
    await wait(1500); // let the sheet engine pick up the new store
    const hp = await setCurrentHp2024(character, exportData.hp.current, exportData.hp.max, exportData.sheetCharacterId);
    if (!hp.ok) warnings.push(`${hp.error} Max HP is set; current HP is ${exportData.hp.current}. (HP section: ${window.__csHpSectionInfo || "not searched"})`);
    else if (hp.verified === null) warnings.push("Current HP was written, but Roll20 didn't let the extension read it back - check it on the sheet once.");
    if (hp.ok) warnings.push(`HP written via ${hp.via}${window.__csHpSectionInfo ? ` - section ${window.__csHpSectionInfo}` : ""}.`);
    const bars = await linkTokenBars(character);
    if (bars.tokens === 0 && !bars.defaultToken) warnings.push("No token for this character yet - drag it onto the map and sync again to link bar 1 to HP and bar 2 to AC.");
    refreshTokens(character);

    const check = await verify2024(character, exportData);
    warnings.push(...check.mismatches);
    if (check.checked === 0) warnings.push("Couldn't read the values back from the Roll20 sheet to double-check them - open the character to confirm.");

    const s = result.stats;
    return {
      summary: `${s.written} sheet entries (${s.attacks} attacks, ${s.spells} spells, ${s.items} items)${check.checked ? `, ${check.checked - check.mismatches.length}/${check.checked} values verified` : ""}${hp.ok ? `, current HP set${hp.via === "setter" ? "" : " (location learned from this game's characters)"}` : ""}${bars.tokens || bars.defaultToken ? `, token bars linked (bar 1 HP, bar 2 AC)` : ""}`,
      warnings,
    };
  }

  async function sync({ exportData, link, profile: requestedProfile }) {
    if (!exportData || typeof exportData !== "object") throw new Error("Empty export.");
    if (exportData.version > SUPPORTED_EXPORT_VERSION) {
      throw new Error("The character sheet app is newer than this extension - update/reload the extension.");
    }
    if (window.is_gm === false) throw new Error("Only the GM can create or update characters this way.");

    const { key: profileKey, profile } = resolveProfile(requestedProfile);
    const plan = profile.build(exportData);

    const linkedCharacter = link && link.roll20CharacterId ? campaign().characters.get(link.roll20CharacterId) : null;
    let character = linkedCharacter || findCharacter({ name: exportData.name });
    let created = false;
    if (!character) {
      character = await createCharacter(exportData.name, profile.sheetName);
      created = true;
    } else if (character.get("name") !== exportData.name) {
      character.save({ name: exportData.name });
    }

    if (profile.engine === "dnd2024") {
      const warnings = [];
      // Characters made by an older version of this extension had no sheet template set.
      if ((created || linkedCharacter) && profile.sheetName && character.get("charactersheetname") !== profile.sheetName) {
        character.save({ charactersheetname: profile.sheetName });
      }
      if (plan.bio && !setBio(character, plan.bio)) warnings.push("Couldn't write the Bio & Info tab on this Roll20 version.");
      const outcome = await sync2024(character, exportData, { created, linked: Boolean(linkedCharacter) });
      return {
        ok: true,
        created,
        roll20CharacterId: character.id,
        roll20Name: character.get("name"),
        campaignId: window.campaign_id || null,
        profile: profileKey,
        summary: `${outcome.summary}, sheet: ${profile.label}`,
        warnings: [...warnings, ...outcome.warnings],
      };
    }

    await loadAttribs(character);
    const index = attrIndex(character);
    const counters = { fields: 0, rowsCreated: 0, rowsRemoved: 0 };
    for (const attr of plan.attrs) if (upsertAttr(character, index, attr)) counters.fields++;
    for (const [section, rows] of Object.entries(plan.repeating || {})) syncRepeating(character, index, section, rows, counters);

    const warnings = [...(plan.notes || [])];
    if (plan.bio && !setBio(character, plan.bio)) warnings.push("Couldn't write the Bio & Info tab on this Roll20 version.");

    const summary = [
      `${counters.fields} field${counters.fields === 1 ? "" : "s"} changed`,
      counters.rowsCreated && `${counters.rowsCreated} rows added`,
      counters.rowsRemoved && `${counters.rowsRemoved} rows removed`,
      plan.bio && "bio written",
      `sheet: ${profile.label}`,
    ]
      .filter(Boolean)
      .join(", ");

    return {
      ok: true,
      created,
      roll20CharacterId: character.id,
      roll20Name: character.get("name"),
      campaignId: window.campaign_id || null,
      profile: profileKey,
      summary,
      warnings,
    };
  }

  async function hp({ update, link, profile: requestedProfile }) {
    const character = findCharacter({ roll20CharacterId: link && link.roll20CharacterId, name: update.name });
    if (!character) return { ok: false, error: `No Roll20 character "${update.name}" - press Sync with Roll20 first.` };
    const { profile } = resolveProfile(requestedProfile);
    if (profile.engine === "dnd2024") {
      const result = await setCurrentHp2024(character, update.current, update.max, update.sheetCharacterId);
      if (result.ok) refreshTokens(character);
      return { ...result, roll20CharacterId: character.id };
    }
    if (profile.hpAttr === null) return { ok: false, error: `HP isn't mapped for the ${profile.label} sheet yet.` };
    const hpAttr = profile.hpAttr || "hp";
    await loadAttribs(character);
    const changed = upsertAttr(character, attrIndex(character), { name: hpAttr, current: update.current, max: update.max });
    return { ok: true, changed, roll20CharacterId: character.id };
  }

  /** Read-only dump of one character's Roll20 data, for mapping a sheet template's fields. */
  async function inspect({ name }) {
    const c = campaign();
    const cut = (v, n) => (typeof v === "string" ? v.slice(0, n) : v);
    const out = {
      url: location.href,
      isGM: window.is_gm,
      campaignId: window.campaign_id,
      detectedProfile: detectProfile(),
      campaign: Object.fromEntries(
        Object.entries(c.attributes || {})
          .filter(([, v]) => v === null || typeof v !== "object")
          .map(([k, v]) => [k, cut(v, 300)])
      ),
      characters: c.characters.models.map((ch) => ({ id: ch.id, name: ch.get("name") })),
    };
    const target = name ? findCharacter({ name }) : c.characters.models[0];
    if (target) {
      await loadAttribs(target);
      out.target = {
        id: target.id,
        attributes: Object.fromEntries(Object.entries(target.attributes).map(([k, v]) => [k, cut(v, 2000)])),
        methods: Object.getOwnPropertyNames(Object.getPrototypeOf(target)).slice(0, 120),
        // Advanced (Beacon) sheets keep their data as objects, not strings - keep those as-is.
        attribs: target.attribs.models.map((a) => {
          const current = a.get("current");
          return {
            name: a.get("name"),
            current: current && typeof current === "object" ? current : cut(str(current), 20000),
            max: cut(str(a.get("max")), 200),
          };
        }),
      };
    }
    return { ok: true, dump: out };
  }

  function status() {
    try {
      const c = campaign();
      return { ok: true, loaded: true, isGM: window.is_gm, campaignId: window.campaign_id || null, characters: c.characters.length, detectedProfile: detectProfile() };
    } catch (error) {
      return { ok: true, loaded: false, error: error.message };
    }
  }

  const handlers = { SYNC: sync, HP: hp, INSPECT: inspect, STATUS: status };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== FROM_ISOLATED || !handlers[data.type]) return;
    let result;
    try {
      result = await handlers[data.type](data.payload || {});
    } catch (error) {
      result = { ok: false, error: error && error.message ? error.message : String(error) };
    }
    window.postMessage({ source: FROM_PAGE, requestId: data.requestId, result }, location.origin);
  });
})();
