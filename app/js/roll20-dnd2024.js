// "D&D 2024 by Roll20" writer. Runs in Roll20's page context (MAIN world),
// loaded before roll20-page.js; also loadable in Node for tests.
//
// The 2024 sheet keeps a whole character in one `store` attribute (an
// object, not a string). Everything mechanical lives in
// store.integrants.integrants - a flat map of typed entries ("integrants")
// that point at each other through parentID / childIDs:
//
//   Class ─ Class Level ─ (features, HP, hit dice, proficiencies...)
//   Features "Spellcasting" ─ Spellcasting (ability) + Spell ─ Attack ─ Damage
//   Item ─ Attack ─ Damage
//   Ability Score ("Set Base" 15), Proficiency, Language, Speed, Armor Class...
//
// The sheet computes the final numbers from these, exactly as it does for a
// character made with its own builder. Every entry this file writes has
// builderIteration "cs-sync" and a deterministic id, so a re-sync removes
// its previous entries and writes fresh ones without touching anything else
// (the sheet's defaults, or things added by hand in Roll20).

(() => {
  const SYNC_TAG = "cs-sync";
  const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
  const LEVEL_KEYS = ["CANTRIP", "FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH", "SIXTH", "SEVENTH", "EIGHTH", "NINTH"];
  const ABILITY_NAMES = {
    strength: "Strength",
    dexterity: "Dexterity",
    constitution: "Constitution",
    intelligence: "Intelligence",
    wisdom: "Wisdom",
    charisma: "Charisma",
  };

  /** Stable 21-char id from a key (FNV-1a based), so re-syncs overwrite rather than duplicate. */
  function stableId(key, length = 21) {
    let out = "cs";
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let round = 0; out.length < length; round++) {
      for (let i = 0; i < key.length; i++) {
        h1 = Math.imul(h1 ^ key.charCodeAt(i), 16777619) >>> 0;
        h2 = Math.imul(h2 ^ (key.charCodeAt(i) + round), 2246822519) >>> 0;
      }
      out += ID_CHARS[h1 % 64] + ID_CHARS[h2 % 64] + ID_CHARS[(h1 >>> 6) % 64] + ID_CHARS[(h2 >>> 6) % 64];
    }
    return out.slice(0, length);
  }

  const title = (s) => String(s || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());

  /** "2d6+3" / "1d8" / "4" -> { count, size, bonus } or null for anything fancier ("3 × (1d4 + 1)"). */
  function parseDice(formula) {
    const f = String(formula || "").replace(/\s+/g, "");
    // "3×(1d4+1)" (Magic Missile's darts) -> all instances added together: 3d4+3.
    const times = f.match(/^(\d+)[×x*]\((.+)\)$/i);
    if (times) {
      const inner = parseDice(times[2]);
      const n = Number(times[1]);
      return inner ? { count: inner.count * n, size: inner.size, bonus: inner.bonus * n } : null;
    }
    let m = f.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
    if (m) return { count: Number(m[1]), size: `d${m[2]}`, bonus: m[3] ? Number(m[3]) : 0 };
    m = f.match(/^([+-]?\d+)([+-]\d+)?$/);
    if (m) return { count: 0, size: "", bonus: Number(m[1]) + (m[2] ? Number(m[2]) : 0) };
    return null;
  }

  function actionTypeFor(castingTime) {
    const t = String(castingTime || "").toLowerCase();
    if (t.includes("bonus")) return "Bonus Action";
    if (t.includes("reaction")) return "Reaction";
    return "Action";
  }

  function componentsFor(list) {
    const out = {};
    for (const raw of list || []) {
      const c = String(raw).trim();
      if (/^V\b/i.test(c)) out.verbal = true;
      else if (/^S\b/i.test(c)) out.somatic = true;
      else if (/^M\b/i.test(c)) {
        out.material = true;
        const desc = c.match(/\((.*)\)/);
        if (desc) out.materialDescription = desc[1];
      }
    }
    return out;
  }

  /**
   * Builds the new store for `exp` (the character sheet app's Roll20 export).
   * `current` is the character's existing store (or null), `template` a blank
   * store used when there is none. Returns { store, stats, notes }.
   */
  function buildStore(exp, current, template, now = Date.now()) {
    const base = JSON.parse(JSON.stringify(current && current.integrants ? current : template));
    const ints = base.integrants.integrants;
    const notes = [];

    // Drop our entries from the previous sync (and any display-order references to them).
    const removed = new Set(Object.keys(ints).filter((id) => ints[id] && ints[id].builderIteration === SYNC_TAG));
    for (const id of removed) delete ints[id];

    const created = [];
    let seq = 0;
    function add(key, type, fields) {
      const id = stableId(`${exp.sheetCharacterId}|${key}`);
      const entry = {
        _enabled: true,
        _id: id,
        builderDisplayName: "",
        builderIteration: SYNC_TAG,
        childIDs: [],
        createdTime: now + seq++,
        label: "",
        name: fields.name || "",
        parentID: "",
        recordName: fields.name || "",
        shortID: id.slice(2, 11),
        source: "Custom",
        type,
        ...fields,
      };
      ints[id] = entry;
      created.push(entry);
      if (entry.parentID && ints[entry.parentID] && Array.isArray(ints[entry.parentID].childIDs)) {
        ints[entry.parentID].childIDs.push(id);
      }
      return id;
    }

    // --- identity: classes, subclasses, species, background -----------------
    const classLevelIds = [];
    exp.classes.forEach((cls, i) => {
      const classId = add(`class:${i}`, "Class", { name: cls.name, compendiumPageID: "" });
      let subclassId = "";
      if (cls.subclass) {
        subclassId = add(`subclass:${i}`, "Subclass", { name: cls.subclass, parentID: classId, source: "Class", sourceID: classId });
      }
      const levelId = add(`classlevel:${i}`, "Class Level", {
        name: cls.name,
        recordName: `${cls.name} Level ${cls.level}`,
        classID: classId,
        subClassID: subclassId,
        level: cls.level,
        totalLevel: exp.level,
        parentID: classId,
        source: "Class",
        sourceID: classId,
      });
      classLevelIds.push(levelId);
      add(`hitdice:${i}`, "Hit Dice", {
        name: `${cls.name} Hit Dice`,
        ability: "Constitution",
        classID: classId,
        dieCount: cls.level,
        dieSize: cls.hitDie,
        recovery: "Long",
        parentID: levelId,
        source: "Class",
        sourceID: classId,
      });
    });
    const mainLevelId = classLevelIds[0] || "";

    const speciesId = add("species", "Species", { name: exp.species.name, description: "", preventSubspecies: true });
    add("speed", "Speed", {
      name: `${exp.speed} Speed`,
      calculation: "Set Base",
      speed: "Walk",
      valueFormula: { flatValue: exp.speed },
      parentID: speciesId,
      source: "Species",
      sourceID: speciesId,
    });
    const backgroundFeature = exp.features.find((f) => f.source === "background");
    add("background", "Background", {
      name: exp.background.name,
      description: backgroundFeature ? `${backgroundFeature.name}. ${backgroundFeature.description}` : "",
    });

    // --- ability scores: one "Set Base" with the app's final score -----------
    for (const [key, label] of Object.entries(ABILITY_NAMES)) {
      add(`ability:${key}`, "Ability Score", {
        name: `${label} Score`,
        ability: label,
        calculation: "Set Base",
        valueFormula: { flatValue: exp.abilities[key].score },
      });
    }

    // --- hit points (max) and armor class -----------------------------------
    add("hp:max", "Hit Points", {
      name: "Hit Points - Max",
      calculation: "Modify",
      hitpointType: "Maximum",
      isFixed: true,
      isTemp: false,
      valueFormula: { flatValue: exp.hp.max },
      parentID: mainLevelId,
      source: "Class",
    });
    add("ac", "Armor Class", {
      name: "Armor Class (from character sheet)",
      calculation: "Set Value",
      defaultAbility: false,
      valueFormula: { flatValue: exp.armorClass },
    });

    // --- proficiencies & languages -------------------------------------------
    const prof = (key, category, proficiency, name) =>
      add(`prof:${key}`, "Proficiency", {
        name,
        category,
        proficiency,
        proficiencyLevel: "Proficient",
        increaseIfAlreadyAt: false,
        notes: "",
        rollAbility: "Query Attribute",
        parentID: mainLevelId,
        source: "Class",
      });
    for (const [key, label] of Object.entries(ABILITY_NAMES)) {
      if (exp.abilities[key].saveProficient) prof(`save:${key}`, "Saving Throw", label, `${label} Save Proficiency`);
    }
    for (const skill of exp.skills) if (skill.proficient) prof(`skill:${skill.name}`, "Skill", skill.name, `${skill.name} Proficiency`);
    for (const w of exp.proficiencies.weapons) {
      const simpleMartial = w.match(/^(simple|martial)\b/i);
      prof(`weapon:${w}`, "Weapon", simpleMartial ? title(simpleMartial[1]) : w.replace(/s$/, ""), `${w} Proficiency`);
    }
    for (const a of exp.proficiencies.armor) {
      const kind = a.match(/^(light|medium|heavy)\b/i);
      prof(`armor:${a}`, "Armor", kind ? title(kind[1]) : /shield/i.test(a) ? "Shields" : a, `${a} Proficiency`);
    }
    for (const t of exp.proficiencies.tools) prof(`tool:${t}`, "Tool", t, `${t} Proficiency`);
    for (const lang of exp.proficiencies.languages) add(`lang:${lang}`, "Language", { name: lang });

    // --- features & traits ---------------------------------------------------
    const featureOrder = { classFeatureDisplayOrder: [], speciesTraitsDisplayOrder: [], featsDisplayOrder: [], otherDisplayOrder: [] };
    exp.features.forEach((f, i) => {
      if (f.source === "background") return; // folded into the Background entry above
      const source = { class: "Class", subclass: "Class", species: "Species", feat: "Features" }[f.source] || "Custom";
      const id = add(`feature:${i}:${f.source}:${f.name}`, "Features", {
        name: f.name,
        description: f.description || "",
        parentID: f.source === "class" || f.source === "subclass" ? classLevelIds[0] || "" : f.source === "species" ? speciesId : "",
        source,
      });
      const bucket =
        f.source === "species" ? "speciesTraitsDisplayOrder" : f.source === "feat" ? "featsDisplayOrder" : f.source === "class" || f.source === "subclass" ? "classFeatureDisplayOrder" : "otherDisplayOrder";
      featureOrder[bucket].push(id);
    });

    // --- attacks from weapons (as inventory items with attacks) --------------
    const attackOrder = [];
    const inventoryOrder = [];
    const weaponItems = new Map();
    exp.attacks.forEach((atk, i) => {
      if (atk.isUnarmedStrike) return; // the sheet has its own Unarmed Strike
      const itemId = add(`weapon:${i}:${atk.name}`, "Item", {
        name: atk.name,
        cost: "",
        description: atk.description || "",
        equipData: { equippable: true, equipped: true },
        properties: JSON.stringify(atk.properties.map(title)),
        quantity: 1,
        rarity: "",
        tempShopData: { compendiumUrl: "", useCompendiumLink: false },
        weaponData: { category: atk.type === "ranged" ? "Ranged" : "Melee", training: "Simple", type: atk.name },
        weight: 0,
        source: "Item",
      });
      weaponItems.set(atk.name, itemId);
      inventoryOrder.push(itemId);
      const variants = [{ suffix: "", damage: atk.damage }];
      if (atk.versatileDamage) variants.push({ suffix: " (Two-Handed)", damage: atk.versatileDamage });
      variants.forEach((variant, v) => {
        const attackId = add(`attack:${i}:${v}`, "Attack", {
          name: `${atk.name}${variant.suffix}`,
          actionType: "Action",
          attack: {
            abilityBonus: ABILITY_NAMES[atk.ability] || "Strength",
            type: atk.type === "ranged" ? "Ranged" : "Melee",
            ...(atk.proficient ? { proficiencyLevel: "Proficient" } : {}),
          },
          description: atk.description || "",
          parentID: itemId,
          source: "Item",
          sourceID: itemId,
        });
        attackOrder.push(attackId);
        const dice = parseDice(variant.damage);
        if (dice) {
          add(`attack:${i}:${v}:damage`, "Damage", {
            name: `${atk.name}${variant.suffix} Damage`,
            _diceCount: dice.count,
            diceSize: dice.size,
            _bonus: dice.bonus,
            ability: "none",
            critDiceSize: "",
            damageType: title(atk.damageType),
            overrideCrit: false,
            parentID: attackId,
            source: "Item",
            sourceID: itemId,
          });
        }
      });
      const extra = atk.attackBonus - (atk.proficient ? exp.proficiencyBonus : 0) - exp.abilities[atk.ability].mod;
      if (extra) notes.push(`${atk.name}: its ${extra > 0 ? "+" : ""}${extra} to-hit bonus (magic/fighting style) isn't added in Roll20 yet - damage is exact.`);
    });

    // --- armor, gear, magic items --------------------------------------------
    for (const item of exp.inventory) {
      if (weaponItems.has(item.name) && /weapon/.test(item.category)) continue;
      const armor = /armor|shield/.test(item.category);
      inventoryOrder.push(
        add(`item:${inventoryOrder.length}:${item.name}`, "Item", {
          name: item.name,
          cost: "",
          description: item.description || "",
          equipData: armor ? { equippable: true, equipped: Boolean(item.equipped) } : { equippable: false },
          quantity: item.quantity,
          rarity: "",
          tempShopData: { compendiumUrl: "", useCompendiumLink: false },
          weight: item.weight || 0,
          source: "Item",
        })
      );
    }
    for (const item of exp.magicItems) {
      const attune = item.requiresAttunement ? `Requires attunement${typeof item.requiresAttunement === "string" ? ` ${item.requiresAttunement}` : ""}.\n\n` : "";
      const charges = item.chargesMax ? `\n\nCharges: ${item.chargesMax}${item.recharge ? ` (recharge: ${item.recharge})` : ""}` : "";
      inventoryOrder.push(
        add(`magic:${inventoryOrder.length}:${item.name}`, "Item", {
          name: item.name,
          cost: "",
          description: `${attune}${item.description}${charges}`,
          equipData: { equippable: true, equipped: true },
          quantity: 1,
          rarity: title(item.rarity),
          tempShopData: { compendiumUrl: "", useCompendiumLink: false },
          weight: 0,
          source: "Item",
        })
      );
    }

    // --- spellcasting, slots, spells -----------------------------------------
    const spellOrder = LEVEL_KEYS.map(() => []);
    if (exp.spellcasting || exp.spells.length) {
      const scName = exp.spellcasting ? exp.spellcasting.className : "Spells";
      const featureId = add("spellcasting:feature", "Features", {
        name: "Spellcasting",
        description: exp.spellcasting
          ? `${scName} spellcasting - ${ABILITY_NAMES[exp.spellcasting.ability]}. Spell attack ${exp.spellcasting.attackBonus >= 0 ? "+" : ""}${exp.spellcasting.attackBonus}, save DC ${exp.spellcasting.saveDC}.`
          : "",
        parentID: mainLevelId,
        source: "Class",
      });
      featureOrder.classFeatureDisplayOrder.push(featureId);
      if (exp.spellcasting) {
        add("spellcasting", "Spellcasting", {
          name: scName,
          ability: ABILITY_NAMES[exp.spellcasting.ability],
          casterType: "other", // slots come from the explicit Spell Slot entries below
          overviewDisplay: true,
          parentID: featureId,
          source: "Class",
        });
      }
      for (const slot of exp.spellSlots) {
        add(`slot:${slot.level}`, "Spell Slot", {
          name: `Level ${slot.level} Spell Slots ${slot.max}`,
          _slotType: "full",
          calculation: "Set Base",
          spellLevel: slot.level,
          valueFormula: { flatValue: slot.max },
          parentID: featureId,
          source: "Class",
        });
      }
      for (const slot of exp.pactSlots) {
        add(`pact:${slot.level}`, "Spell Slot", {
          name: `Pact Magic Level ${slot.level} Slots ${slot.max}`,
          _slotType: "pact",
          calculation: "Set Base",
          spellLevel: slot.level,
          valueFormula: { flatValue: slot.max },
          parentID: featureId,
          source: "Class",
        });
      }
      exp.spells.forEach((spell, i) => {
        const spellId = add(`spell:${i}:${spell.name}`, "Spell", {
          name: spell.name,
          level: spell.level,
          school: title(spell.school),
          castingTime: spell.castingTime,
          range: spell.range,
          duration: spell.duration,
          description: spell.description,
          components: componentsFor(spell.components),
          ...(spell.concentration ? { concentration: true } : {}),
          ...(spell.ritual ? { ritual: true } : {}),
          ...(spell.upcastNote ? { upcastText: spell.upcastNote } : {}),
          _prepared: true,
          alwaysPrepared: Boolean(spell.granted),
          parentID: featureId,
          source: "Class",
        });
        spellOrder[Math.min(9, Math.max(0, spell.level))].push(spellId);
        const damaging = spell.rolls.filter((r) => r.kind === "damage" || r.kind === "healing");
        if (!spell.attack && !spell.save && damaging.length === 0) return;
        const attackId = add(`spell:${i}:attack`, "Attack", {
          name: spell.name,
          actionType: actionTypeFor(spell.castingTime),
          attack: spell.attack ? { type: "Spell Attack" } : spell.save ? { type: "Spell Save" } : { type: "Spell Attack" },
          ...(spell.save ? { save: { saveAbility: ABILITY_NAMES[spell.save] } } : {}),
          description: spell.description,
          range: spell.range,
          parentID: spellId,
          source: "Spell",
          sourceID: spellId,
        });
        attackOrder.push(attackId);
        damaging.forEach((roll, r) => {
          const dice = parseDice(roll.formula);
          if (!dice) {
            notes.push(`${spell.name}: "${roll.formula}" couldn't be turned into a Roll20 damage roll - it's in the spell text.`);
            return;
          }
          add(`spell:${i}:damage:${r}`, "Damage", {
            name: `${spell.name} ${roll.kind === "healing" ? "Healing" : "Damage"}`,
            _diceCount: dice.count,
            diceSize: dice.size,
            _bonus: dice.bonus,
            ability: "none",
            critDiceSize: "",
            damageType: roll.kind === "healing" ? "Healing" : title(roll.damageType || ""),
            overrideCrit: false,
            parentID: attackId,
            source: "Spell",
            sourceID: spellId,
          });
        });
      });
    }

    // Integrant childIDs are JSON strings in the real store.
    for (const entry of created) entry.childIDs = JSON.stringify(entry.childIDs);

    // --- display orders: keep the non-synced ids, then ours ------------------
    const keepOrder = (json, add) => {
      let list = [];
      try {
        list = JSON.parse(json || "[]");
      } catch {
        list = [];
      }
      return JSON.stringify([...list.filter((id) => !removed.has(id) && ints[id]), ...add]);
    };
    base.attacks = { ...(base.attacks || {}), attackDisplayOrder: keepOrder(base.attacks && base.attacks.attackDisplayOrder, attackOrder) };
    base.features = base.features || {};
    for (const [bucket, ids] of Object.entries(featureOrder)) base.features[bucket] = keepOrder(base.features[bucket], ids);
    base.inventory = { ...(base.inventory || {}), equipmentDisplayOrder: keepOrder(base.inventory && base.inventory.equipmentDisplayOrder, inventoryOrder) };
    base.spells = base.spells || {};
    const oldSpellOrder = Array.isArray(base.spells.displayOrder) ? base.spells.displayOrder : [];
    base.spells.displayOrder = LEVEL_KEYS.map((_, level) => keepOrder(oldSpellOrder[level], spellOrder[level]));

    // --- plain values ---------------------------------------------------------
    const currencyIds = { copper: "cp", silver: "sp", electrum: "ep", gold: "gp", platinum: "pp" };
    for (const [id, key] of Object.entries(currencyIds)) if (ints[id]) ints[id].value = exp.currency[key];
    base.spellSlots = base.spellSlots || {};
    base.spellSlots.currentByLevel = { ...(base.spellSlots.currentByLevel || {}) };
    base.spellSlots.currentPactByLevel = { ...(base.spellSlots.currentPactByLevel || {}) };
    for (const key of LEVEL_KEYS) {
      base.spellSlots.currentByLevel[key] = 0;
      base.spellSlots.currentPactByLevel[key] = 0;
    }
    for (const slot of exp.spellSlots) base.spellSlots.currentByLevel[LEVEL_KEYS[slot.level]] = slot.max - slot.expended;
    for (const slot of exp.pactSlots) base.spellSlots.currentPactByLevel[LEVEL_KEYS[slot.level]] = slot.max - slot.expended;
    base.inspiration = { ...(base.inspiration || {}), isInspired: Boolean(exp.trackers.inspiration) };
    const conditions = new Set(exp.trackers.conditions.map((c) => c.toLowerCase()));
    for (const entry of Object.values(ints)) {
      if (entry.type === "Condition" && !entry.custom && entry.source === "") entry._active = conditions.has(String(entry.name).toLowerCase());
    }
    base.character = { ...(base.character || {}), createdWithBuilder: false };

    return {
      store: base,
      stats: { written: created.length, removed: removed.size, attacks: attackOrder.length, spells: exp.spells.length, items: inventoryOrder.length },
      notes,
    };
  }

  /** True if the store has entries made by Roll20's own builder (i.e. someone built this character in Roll20). */
  function hasBuilderContent(store) {
    const ints = store && store.integrants && store.integrants.integrants;
    if (!ints) return false;
    return Object.values(ints).some((e) => e && e.builderIteration && e.builderIteration !== SYNC_TAG);
  }

  // --- current HP ------------------------------------------------------------
  //
  // Roll20 keeps a display summary of every character in `custom_meta1`
  // ({"hp":{"current","max","temp"}}). For characters that are hurt (current
  // below max), finding which number in their store equals current HP (or the
  // damage taken, max - current) tells us where the 2024 sheet keeps it -
  // learned from the game's own characters instead of guessed.

  function readMetaHp(customMeta1) {
    try {
      const meta = typeof customMeta1 === "string" ? JSON.parse(customMeta1) : customMeta1;
      const hp = meta && meta.hp;
      if (!hp || typeof hp.current !== "number" || typeof hp.max !== "number") return null;
      return { current: hp.current, max: hp.max, temp: Number(hp.temp) || 0 };
    } catch {
      return null;
    }
  }

  /** Numbers in `store` that equal current HP or damage taken, as location keys that mean the same thing across characters. */
  function hpCandidates(store, hp) {
    const out = [];
    if (!store || !hp || hp.current <= 0 || hp.current >= hp.max) return out; // need distinct current/damage values
    const targets = [
      { semantics: "current", value: hp.current },
      { semantics: "damage", value: hp.max - hp.current },
    ];
    const ints = (store.integrants && store.integrants.integrants) || {};
    const walk = (value, path) => {
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
        return;
      }
      const num = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (Number.isNaN(num)) return;
      let key;
      let example = null;
      let field;
      if (path[0] === "integrants" && path[1] === "integrants" && ints[path[2]]) {
        const entry = ints[path[2]];
        field = path.slice(3).join(".");
        key = `int|${entry.type}|${entry.hitpointType || ""}|${entry.isTemp ? "temp" : ""}|${field}`;
        example = entry;
      } else {
        field = path.join(".");
        key = `path|${field}`;
      }
      if (!/hit|hp|damage/i.test(key) || /max/i.test(`${example ? example.hitpointType || "" : ""}|${field}`)) return;
      for (const target of targets) if (num === target.value) out.push({ key, semantics: target.semantics, field, example });
    };
    walk(store, []);
    return out;
  }

  /** Picks the location most characters agree on. `samples` = [{ store, hp }]. */
  function learnHpShape(samples) {
    const tally = new Map();
    for (const { store, hp } of samples) {
      const seen = new Set();
      for (const c of hpCandidates(store, hp)) {
        const id = `${c.key}|${c.semantics}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = tally.get(id) || { ...c, count: 0 };
        entry.count++;
        tally.set(id, entry);
      }
    }
    const best = [...tally.values()].sort((a, b) => b.count - a.count)[0];
    if (!best) return null;
    return {
      kind: best.key.startsWith("int|") ? "integrant" : "path",
      semantics: best.semantics,
      field: best.field,
      example: best.example ? JSON.parse(JSON.stringify(best.example)) : null,
      agreedBy: best.count,
      samples: samples.length,
    };
  }

  function setPath(obj, dotted, value) {
    const parts = dotted.split(".");
    let node = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }

  /** Writes current HP into `store` (a copy) the way `shape` says the sheet keeps it. */
  function applyHp(store, shape, current, max, sheetCharacterId) {
    const next = JSON.parse(JSON.stringify(store));
    const value = shape.semantics === "damage" ? Math.max(0, max - current) : current;
    if (shape.kind === "path") {
      setPath(next, shape.field, value);
      return next;
    }
    const ints = next.integrants.integrants;
    const ex = shape.example;
    // A sheet-default entry (no builderIteration, e.g. a fixed id) is reused as-is by id;
    // otherwise the entry is one of ours, tagged so re-syncs replace it.
    const isDefault = !ex.builderIteration;
    const id = isDefault ? ex._id : stableId(`${sheetCharacterId}|hp:current`);
    const existing =
      ints[id] ||
      Object.values(ints).find(
        (e) => e.type === ex.type && (e.hitpointType || "") === (ex.hitpointType || "") && Boolean(e.isTemp) === Boolean(ex.isTemp)
      );
    const entry = existing || {
      ...ex,
      _id: id,
      shortID: id.slice(2, 11),
      childIDs: "[]",
      parentID: "",
      createdTime: Date.now(),
      ...(isDefault ? {} : { builderIteration: SYNC_TAG, source: "Custom", sourceID: undefined }),
    };
    if (!isDefault && !existing) delete entry.sourceID;
    setPath(entry, shape.field, value);
    ints[entry._id] = entry;
    return next;
  }

  // --- the section that holds current HP ------------------------------------
  //
  // The sheet's own HP setter writes `<section>.currentHP`, and that section
  // only exists once a character's HP has been changed. It's found by key
  // name in other characters of the game (any character that has one), then
  // recreated in ours.

  /** All paths (arrays of keys) in `obj` that end in `keyName`. */
  function findKeyPaths(obj, keyName, path = [], out = []) {
    if (!obj || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
      if (k === keyName) out.push([...path, k]);
      if (v && typeof v === "object") findKeyPaths(v, keyName, [...path, k], out);
    }
    return out;
  }

  /** Where `currentHP` sits in `store`, in a form that means the same across characters. */
  function describeHpSection(store) {
    const paths = findKeyPaths(store, "currentHP");
    if (paths.length === 0) return null;
    const path = paths[0];
    const ints = (store.integrants && store.integrants.integrants) || {};
    if (path[0] === "integrants" && path[1] === "integrants" && ints[path[2]]) {
      const entry = ints[path[2]];
      return { kind: "integrant", key: `int|${entry.type}|${path.slice(3).join(".")}`, field: path.slice(3), example: JSON.parse(JSON.stringify(entry)) };
    }
    let parent = store;
    for (const k of path.slice(0, -1)) parent = parent[k];
    return { kind: "path", key: `path|${path.join(".")}`, parentPath: path.slice(0, -1), example: JSON.parse(JSON.stringify(parent)) };
  }

  /** Copy of `value` with numbers zeroed and booleans false - another character's values mustn't leak in. */
  function blankCopy(value) {
    if (Array.isArray(value)) return [];
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankCopy(v)]));
    if (typeof value === "number") return 0;
    if (typeof value === "boolean") return false;
    return value;
  }

  /** Writes current HP into (a copy of) `store`, creating the section first if it's missing. */
  function writeCurrentHp(store, section, current, sheetCharacterId) {
    const next = JSON.parse(JSON.stringify(store));
    if (section.kind === "path") {
      let node = next;
      section.parentPath.forEach((k, i) => {
        if (!node[k] || typeof node[k] !== "object") {
          node[k] = i === section.parentPath.length - 1 ? blankCopy(section.example) : {};
        }
        node = node[k];
      });
      node.currentHP = current;
      return next;
    }
    const ints = next.integrants.integrants;
    const ex = section.example;
    let entry = ints[ex._id] || Object.values(ints).find((e) => e.type === ex.type && findKeyPaths(e, "currentHP").length > 0);
    if (!entry) {
      const isDefault = !ex.builderIteration;
      const id = isDefault ? ex._id : stableId(`${sheetCharacterId}|hp:section`);
      entry = { ...blankCopy(ex), _id: id, _enabled: true, type: ex.type, name: ex.name || "", label: "", shortID: id.slice(2, 11), childIDs: "[]", parentID: "", createdTime: Date.now() };
      if (!isDefault) Object.assign(entry, { builderIteration: SYNC_TAG, source: "Custom" });
      ints[id] = entry;
    }
    let node = entry;
    section.field.slice(0, -1).forEach((k) => {
      if (!node[k] || typeof node[k] !== "object") node[k] = {};
      node = node[k];
    });
    node.currentHP = current;
    return next;
  }

  const api = {
    buildStore,
    findKeyPaths,
    describeHpSection,
    writeCurrentHp,
    hasBuilderContent,
    stableId,
    parseDice,
    readMetaHp,
    hpCandidates,
    learnHpShape,
    applyHp,
    SYNC_TAG,
    LEVEL_KEYS,
  };
  if (typeof window !== "undefined") window.__csDnd2024 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
