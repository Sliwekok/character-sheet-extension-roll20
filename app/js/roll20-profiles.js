// Runs in Roll20's page context (manifest "world": "MAIN"), before
// roll20-page.js. Turns the character sheet app's Roll20 export (see the app's
// src/utils/roll20/roll20Export.ts - Roll20-agnostic, all numbers final) into
// what gets written to one Roll20 character:
//
//   { attrs: [{ name, current, max? }],          plain attributes
//     repeating: { section: [{ key, fields }] }, repeating-section rows
//     bio: "<html>",                              Bio & Info tab
//     hpAttr: "hp",                               attribute HP streams into
//     notes: ["..."] }                            shown to the user as warnings
//
// One profile per Roll20 character sheet template. The field names are the
// only sheet-specific knowledge in the whole extension, so a Roll20 sheet
// update means editing this file and nothing else.

(() => {
  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const para = (text) =>
    String(text ?? "")
      .split(/\n{2,}/)
      .map((block) => `<p>${esc(block).replace(/\n/g, "<br>")}</p>`)
      .join("");
  const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
  const SHORT = { strength: "STR", dexterity: "DEX", constitution: "CON", intelligence: "INT", wisdom: "WIS", charisma: "CHA" };
  const ordinal = (n) => (n === 0 ? "Cantrips" : `Level ${n}`);

  /**
   * A complete, readable copy of the character for the Bio & Info tab. Works
   * on every sheet template (the bio is part of the character itself, not the
   * sheet), so even before a sheet's fields are mapped nothing is lost.
   */
  function renderBio(exp) {
    const out = [];
    out.push(
      `<h2>${esc(exp.name)}</h2>`,
      `<p><i>${esc(exp.species.name)} ${esc(exp.classSummary)} · Level ${exp.level} · ${esc(exp.background.name)} · ${esc(
        exp.alignment
      )} · ${esc(exp.edition)} rules</i></p>`,
      `<p><b>AC</b> ${exp.armorClass}${exp.armorWorn ? ` (${esc(exp.armorWorn)}${exp.shieldWorn ? `, ${esc(exp.shieldWorn)}` : ""})` : ""} · <b>HP</b> ${exp.hp.current}/${exp.hp.max} · <b>Speed</b> ${exp.speed} ft · <b>Initiative</b> ${signed(
        exp.initiative
      )} · <b>Proficiency</b> ${signed(exp.proficiencyBonus)}</p>`,
      `<p>${ABILITIES.map((a) => `<b>${SHORT[a]}</b> ${exp.abilities[a].score} (${signed(exp.abilities[a].mod)})`).join(" · ")}</p>`,
      `<p><b>Saves</b> ${ABILITIES.map((a) => `${SHORT[a]} ${signed(exp.abilities[a].save)}${exp.abilities[a].saveProficient ? "*" : ""}`).join(", ")}</p>`,
      `<p><b>Skills</b> ${exp.skills.map((s) => `${esc(s.name)} ${signed(s.bonus)}${s.proficient ? "*" : ""}`).join(", ")}</p>`,
      `<p><b>Passive</b> Perception ${exp.passive.perception}, Insight ${exp.passive.insight}, Investigation ${exp.passive.investigation}</p>`
    );

    const profs = exp.proficiencies;
    const profLines = [
      profs.armor.length && `<b>Armor:</b> ${esc(profs.armor.join(", "))}`,
      profs.weapons.length && `<b>Weapons:</b> ${esc(profs.weapons.join(", "))}`,
      profs.tools.length && `<b>Tools:</b> ${esc(profs.tools.join(", "))}`,
      profs.languages.length && `<b>Languages:</b> ${esc(profs.languages.join(", "))}`,
    ].filter(Boolean);
    if (profLines.length) out.push(`<p>${profLines.join("<br>")}</p>`);
    if (profs.notes) out.push(para(profs.notes));

    out.push("<h3>Attacks</h3><ul>");
    for (const atk of exp.attacks) {
      out.push(
        `<li><b>${esc(atk.name)}</b> ${signed(atk.attackBonus)} to hit, ${esc(atk.damage)} ${esc(atk.damageType)}${
          atk.versatileDamage ? ` (two-handed ${esc(atk.versatileDamage)})` : ""
        }${atk.mastery ? ` · Mastery: ${esc(atk.mastery)}${atk.masteryActive ? "" : " (not chosen)"}` : ""}</li>`
      );
    }
    out.push("</ul>");

    if (exp.spellcasting || exp.spells.length) {
      out.push("<h3>Spellcasting</h3>");
      if (exp.spellcasting) {
        out.push(
          `<p>${esc(exp.spellcasting.className)} · ${esc(exp.spellcasting.ability)} · Spell attack ${signed(
            exp.spellcasting.attackBonus
          )} · Save DC ${exp.spellcasting.saveDC}</p>`
        );
      }
      const slots = [...exp.spellSlots.map((s) => ({ ...s, pact: false })), ...exp.pactSlots.map((s) => ({ ...s, pact: true }))];
      if (slots.length) {
        out.push(
          `<p><b>Slots</b> ${slots
            .map((s) => `${s.pact ? "Pact " : ""}L${s.level}: ${s.max - s.expended}/${s.max}`)
            .join(" · ")}</p>`
        );
      }
      const byLevel = new Map();
      for (const spell of exp.spells) {
        if (!byLevel.has(spell.level)) byLevel.set(spell.level, []);
        byLevel.get(spell.level).push(spell);
      }
      for (const [level, spells] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
        out.push(`<h4>${ordinal(level)}</h4><ul>`);
        for (const s of spells) {
          const tags = [s.concentration && "C", s.ritual && "R"].filter(Boolean).join(", ");
          const rolls = s.rolls.map((r) => `${esc(r.formula)}${r.damageType ? ` ${esc(r.damageType)}` : ""}`).join(", ");
          out.push(
            `<li><b>${esc(s.name)}</b>${tags ? ` (${tags})` : ""} - ${esc(s.castingTime)}, ${esc(s.range)}, ${esc(
              s.duration
            )}${s.attack ? `, ${s.attack} spell attack` : ""}${s.save ? `, ${esc(s.save)} save` : ""}${rolls ? ` - ${rolls}` : ""}</li>`
          );
        }
        out.push("</ul>");
      }
    }

    if (exp.features.length) {
      out.push("<h3>Features &amp; Traits</h3>");
      for (const f of exp.features) {
        out.push(`<p><b>${esc(f.name)}</b> <i>(${esc(f.sourceName)}${f.level ? ` ${f.level}` : ""})</i></p>${para(f.description)}`);
      }
    }

    out.push("<h3>Equipment</h3><ul>");
    for (const item of exp.inventory) {
      out.push(`<li>${item.quantity > 1 ? `${item.quantity}× ` : ""}${esc(item.name)}${item.equipped ? " (equipped)" : ""}</li>`);
    }
    for (const item of exp.magicItems) {
      out.push(`<li><b>${esc(item.name)}</b> <i>${esc(item.rarity)} ${esc(item.category)}</i>${item.chargesMax ? ` · ${item.chargesMax} charges` : ""}</li>`);
    }
    out.push("</ul>");
    const c = exp.currency;
    out.push(`<p><b>Coins</b> ${c.pp} pp · ${c.gp} gp · ${c.ep} ep · ${c.sp} sp · ${c.cp} cp</p>`);

    const d = exp.details;
    const flavor = [
      ["Personality", d.personalityTraits],
      ["Ideals", d.ideals],
      ["Bonds", d.bonds],
      ["Flaws", d.flaws],
      ["Appearance", [d.age && `Age ${d.age}`, d.height, d.weight, d.eyes && `${d.eyes} eyes`, d.skin && `${d.skin} skin`, d.hair && `${d.hair} hair`]
        .filter(Boolean)
        .join(", ")],
      ["", d.appearance],
      ["Backstory", d.backstory],
      ["Allies & Organizations", d.alliesAndOrganizations],
      ["Additional features", d.additionalFeaturesAndTraits],
      ["Treasure", d.treasure],
    ].filter(([, value]) => value);
    if (flavor.length) {
      out.push("<h3>Background</h3>");
      for (const [label, value] of flavor) out.push(label ? `<p><b>${esc(label)}</b></p>${para(value)}` : para(value));
    }

    out.push(`<p><i>Synced from the character sheet app ${esc(new Date(exp.exportedAt).toLocaleString())}.</i></p>`);
    return out.join("");
  }

  const profiles = {
    /** Works with any sheet: the full character goes to Bio & Info, HP to an `hp` attribute. */
    bio: {
      label: "Bio only (any sheet)",
      hpAttr: "hp",
      build(exp) {
        return {
          attrs: [{ name: "hp", current: exp.hp.current, max: exp.hp.max }],
          repeating: {},
          bio: renderBio(exp),
          notes: [],
        };
      },
    },

    /**
     * "D&D 2024 by Roll20". Its field names haven't been confirmed against a
     * real game yet (the inspect dump from the popup is what pins them down),
     * so for now this writes the bio plus HP only and says so.
     */
    /**
     * "D&D 2024 by Roll20". This sheet has no plain attributes to map - its
     * character lives in one `store` object that roll20-dnd2024.js builds
     * (engine: "dnd2024"). The profile only adds the bio.
     */
    dnd2024: {
      label: "D&D 2024 by Roll20",
      engine: "dnd2024",
      sheetName: "dnd2024byroll20",
      build(exp) {
        return { attrs: [], repeating: {}, bio: renderBio(exp), notes: [] };
      },
    },
  };

  window.__csRoll20Profiles = { profiles, renderBio };
})();
