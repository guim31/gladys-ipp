// -----------------------------------------------------------------------------
// Display names of the device features.
//
// Printers report their supplies in their own words — almost always English,
// lowercase, sometimes decorated with serial numbers ("Black
// Toner_S/N_:CRUM-25111822430"). Gladys features carry a single name (no
// multi-language), so the target language is a configuration choice
// (feature_names: 'printer' | 'fr' | 'en').
//
// Translation works by keyword detection on the raw marker name + type, and
// NEVER touches the feature keys/external_ids (they stay derived from the raw
// name, so translated devices keep the same features and history).
// -----------------------------------------------------------------------------

// Detected color, from the raw marker name. Order matters: the composite
// shades must match before the plain colors they contain.
const COLORS = [
  { match: /photo[ -]?black/, en: 'Photo black', frM: 'noir photo', frF: 'noire photo' },
  { match: /matte[ -]?black/, en: 'Matte black', frM: 'noir mat', frF: 'noire mate' },
  { match: /light[ -]?cyan/, en: 'Light cyan', frM: 'cyan clair', frF: 'cyan clair' },
  { match: /light[ -]?magenta/, en: 'Light magenta', frM: 'magenta clair', frF: 'magenta clair' },
  { match: /black|noir/, en: 'Black', frM: 'noir', frF: 'noire' },
  { match: /cyan/, en: 'Cyan', frM: 'cyan', frF: 'cyan' },
  { match: /magenta/, en: 'Magenta', frM: 'magenta', frF: 'magenta' },
  { match: /yellow|jaune/, en: 'Yellow', frM: 'jaune', frF: 'jaune' },
  { match: /gr[ae]y|gris/, en: 'Gray', frM: 'gris', frF: 'grise' },
  { match: /tri-?colou?r|colou?r/, en: 'Tri-color', frM: 'trois couleurs', frF: 'trois couleurs' },
];

/**
 * Best-effort display name of a supply, in the requested language.
 * 'printer' (the default) returns the raw name untouched; 'fr'/'en' build a
 * clean "<kind> <color>" label when a color is recognized, and fall back to
 * the raw name otherwise (never worse than today).
 * @param {{ name: string, type: string|null }} marker parsed marker
 * @param {'printer'|'fr'|'en'} lang
 * @returns {string}
 */
export function displayMarkerName(marker, lang) {
  if (lang !== 'fr' && lang !== 'en') {
    return marker.name;
  }
  const haystack = `${marker.name} ${marker.type ?? ''}`.toLowerCase();
  const color = COLORS.find((c) => c.match.test(haystack));

  // Waste containers have no color but a very recognizable name. Inkjets
  // call theirs a maintenance box, laser printers a waste toner bottle.
  if (WASTE.test(haystack)) {
    if (/ink|encre|maintenance[ -]?box/.test(haystack)) {
      return lang === 'fr' ? "Bac de récupération d'encre" : 'Waste ink container';
    }
    return lang === 'fr' ? 'Récupérateur de toner' : 'Waste container';
  }
  // Printer parts (drum, imaging unit, fuser...) used to fall through to the
  // cartridge rule below ("Black Drum Unit" became "Encre noire"). Feature
  // names are frozen at creation, so this only names NEW features right.
  const part = findPart(marker, haystack);
  if (part?.id === 'roller') {
    return rollerName(haystack, lang, 'long');
  }
  if (part) {
    if (!color) {
      return part[`long${lang === 'fr' ? 'Fr' : 'En'}`];
    }
    return lang === 'fr'
      ? `${part.longFr} ${part.feminine ? color.frF : color.frM}`
      : `${color.en} ${part.longEn.toLowerCase()}`;
  }
  if (!color) {
    return marker.name;
  }

  const isToner = /toner/.test(haystack);
  const isInk = /ink|encre/.test(haystack) || /cartridge|cartouche/.test(haystack);
  if (lang === 'en') {
    const kind = isToner ? 'toner' : isInk ? 'ink' : 'cartridge';
    return `${color.en} ${kind}`;
  }
  // French: the kind carries the grammatical gender of the color adjective.
  if (isToner) {
    return `Toner ${color.frM}`;
  }
  return `Encre ${color.frF}`;
}

/**
 * Display name of the printer state feature.
 * @param {'printer'|'fr'|'en'} lang
 * @returns {string}
 */
export function displayStateName(lang) {
  return lang === 'fr' ? 'État' : 'State';
}

// Short color names for the dashboard widgets (a gauge label holds 24
// characters): the color alone, the kind only when it is not a cartridge.
const SHORT_COLORS = {
  'Photo black': { en: 'Photo black', fr: 'Noir photo' },
  'Matte black': { en: 'Matte black', fr: 'Noir mat' },
  'Light cyan': { en: 'Light cyan', fr: 'Cyan clair' },
  'Light magenta': { en: 'Light magenta', fr: 'Magenta clair' },
  Black: { en: 'Black', fr: 'Noir' },
  Cyan: { en: 'Cyan', fr: 'Cyan' },
  Magenta: { en: 'Magenta', fr: 'Magenta' },
  Yellow: { en: 'Yellow', fr: 'Jaune' },
  Gray: { en: 'Gray', fr: 'Gris' },
  'Tri-color': { en: 'Tri-color', fr: 'Trois couleurs' },
};

/**
 * Short display name of a supply for a widget tile (≤ 24 characters): the
 * color alone for an ink or toner cartridge ("Noir", "Cyan"), the part for
 * the others ("Tambour", "Four", "Récupérateur"). 'printer' keeps the raw
 * name, shortened. Never empty.
 * @param {{ name: string, type: string|null }} marker parsed marker
 * @param {'printer'|'fr'|'en'} lang language of the feature names
 * @returns {string}
 */
export function shortMarkerName(marker, lang) {
  const raw = String(marker.name ?? '').trim() || 'Cartridge';
  if (lang !== 'fr' && lang !== 'en') {
    return fitLabel(raw);
  }
  const haystack = `${raw} ${marker.type ?? ''}`.toLowerCase();
  const color = COLORS.find((c) => c.match.test(haystack));
  const colorName = color ? SHORT_COLORS[color.en][lang] : null;

  if (WASTE.test(haystack)) {
    return lang === 'fr' ? 'Récupérateur' : 'Waste';
  }
  const part = findPart(marker, haystack);
  if (part?.id === 'roller') {
    return rollerName(haystack, lang, 'short');
  }
  if (part) {
    if (!colorName) {
      return part[lang];
    }
    return lang === 'fr' ? `${part.fr} ${colorName.toLowerCase()}` : `${colorName} ${part.en}`;
  }
  return colorName ?? fitLabel(raw);
}

// Waste containers: a laser's waste toner bottle, an inkjet's maintenance box.
const WASTE = /waste|maintenance[ -]?box|r[ée]cup[ée]rat/;

// Printer parts that are not cartridges but do report a level over IPP/SNMP.
// `en`/`fr` are the short widget labels, `longEn`/`longFr` the feature names;
// `feminine` drives the french color adjective. `id` identifies the part
// across sources (an IPP "Drum" and an SNMP "Imaging Unit" are the same one).
// Order matters: the imaging unit must match before the plain drum.
const PARTS = [
  {
    id: 'drum',
    match: /imaging[ -]?unit|unit[ée] d'imagerie/,
    en: 'Drum',
    fr: 'Tambour',
    longEn: 'Imaging unit',
    longFr: "Unité d'imagerie",
    feminine: true,
  },
  {
    id: 'drum',
    match: /drum|tambour|\bopc\b|photoconduct/,
    en: 'Drum',
    fr: 'Tambour',
    longEn: 'Drum',
    longFr: 'Tambour',
  },
  {
    id: 'developer',
    match: /develop|d[ée]veloppe/,
    en: 'Developer',
    fr: 'Développeur',
    longEn: 'Developer',
    longFr: 'Développeur',
  },
  {
    id: 'fuser',
    match: /fuser|fixing|four/,
    en: 'Fuser',
    fr: 'Four',
    longEn: 'Fuser',
    longFr: 'Four',
  },
  {
    id: 'transfer',
    match: /transfer|belt|courroie/,
    en: 'Transfer',
    fr: 'Transfert',
    longEn: 'Transfer unit',
    longFr: 'Unité de transfert',
    feminine: true,
  },
  {
    id: 'cleaner',
    match: /clean|nettoyage/,
    en: 'Cleaner',
    fr: 'Nettoyage',
    longEn: 'Cleaning unit',
    longFr: 'Unité de nettoyage',
    feminine: true,
  },
  {
    id: 'roller',
    match: /roller|rouleau/,
    en: 'Roller',
    fr: 'Rouleau',
    longEn: 'Roller',
    longFr: 'Rouleau',
  },
];

// What a roller does, from its raw name. A laser lists several rollers in
// its SNMP table (pickup, separation...) that would all be "Rouleau".
// "Transfer Roller" never gets here: the transfer part matches first.
const ROLLER_KINDS = [
  {
    match: /pick[ _-]?up|prise/,
    en: 'Pickup',
    fr: 'prise',
    longEn: 'Pickup roller',
    longFr: 'Rouleau de prise papier',
  },
  {
    match: /retard|s[ée]paration/,
    en: 'Separation',
    fr: 'séparation',
    longEn: 'Separation roller',
    longFr: 'Rouleau de séparation',
  },
  {
    match: /feed|entra[iî]nement/,
    en: 'Feed',
    fr: 'entraînement',
    longEn: 'Feed roller',
    longFr: "Rouleau d'entraînement",
  },
];

/**
 * The paper tray a supply belongs to, from its raw name: "Tray1", "Tray 2",
 * "Cassette 1", or the multipurpose / manual / bypass tray ("MP", "MPT").
 * @param {string} haystack lowercased "name type"
 * @returns {{ en: string, fr: string, longEn: string, longFr: string }|null}
 */
function trayOf(haystack) {
  const numbered = /(?:tray|bac|cassette)[ _-]?(\d+)/.exec(haystack);
  if (numbered) {
    const n = numbered[1];
    return { en: `tray ${n}`, fr: `bac ${n}`, longEn: `tray ${n}`, longFr: `bac ${n}` };
  }
  if (/\bmpt?\b|multi[ _-]?purpose|multifonction|manual|bypass/.test(haystack)) {
    return {
      en: 'MP tray',
      fr: 'bac MF',
      longEn: 'multipurpose tray',
      longFr: 'bac multifonction',
    };
  }
  return null;
}

/**
 * Name of a roller with its qualifiers: "Rouleau prise bac 1" on a tile,
 * "Rouleau de prise papier (bac 1)" as a feature name. A tile label that
 * would pass 24 characters drops the word "roller" ("Séparation bac MF").
 * @param {string} haystack lowercased "name type"
 * @param {'fr'|'en'} lang
 * @param {'short'|'long'} form
 * @returns {string}
 */
function rollerName(haystack, lang, form) {
  const kind = ROLLER_KINDS.find((k) => k.match.test(haystack));
  const tray = trayOf(haystack);
  if (form === 'long') {
    const base = kind
      ? kind[lang === 'fr' ? 'longFr' : 'longEn']
      : lang === 'fr'
        ? 'Rouleau'
        : 'Roller';
    return tray ? `${base} (${tray[lang === 'fr' ? 'longFr' : 'longEn']})` : base;
  }
  const words = lang === 'fr' ? [kind?.fr, tray?.fr] : [kind?.en, tray?.en];
  const qualifier = words.filter(Boolean).join(' ');
  if (!qualifier) {
    return lang === 'fr' ? 'Rouleau' : 'Roller';
  }
  const full =
    lang === 'fr'
      ? `Rouleau ${qualifier}`
      : kind
        ? `${kind.en} roller${tray ? ` ${tray.en}` : ''}`
        : `Roller ${tray.en}`;
  if (full.length <= 24) {
    return full;
  }
  return fitLabel(qualifier.charAt(0).toUpperCase() + qualifier.slice(1));
}

// Supply types (IPP marker-types and their SNMP equivalents, see
// SUPPLY_TYPES in snmp/supplies.js) that ARE cartridges: never a part, even
// when the name mentions one ("Toner/Drum kit" stays a toner).
export const CARTRIDGE_TYPES = new Set([
  'toner',
  'ink',
  'ink-cartridge',
  'toner-cartridge',
  'ink-ribbon',
]);

/**
 * The part a supply is, from its name and type.
 * @param {{ name?: string, type?: string|null }} marker
 * @param {string} haystack lowercased "name type"
 * @returns {object|undefined} a PARTS entry
 */
function findPart(marker, haystack) {
  if (CARTRIDGE_TYPES.has(marker.type)) {
    return undefined;
  }
  return PARTS.find((p) => p.match.test(haystack));
}

/**
 * Identify a printer part (anything but an ink/toner cartridge) by its name
 * and type: 'drum', 'developer', 'fuser', 'transfer', 'cleaner', 'roller',
 * 'waste', or null for a cartridge or an unrecognized supply. Shared by the
 * names and by the SNMP complement, which must not add a part IPP already
 * announces under another name.
 * @param {{ name?: string, type?: string|null }} marker
 * @returns {string|null}
 */
export function markerPart(marker) {
  if (CARTRIDGE_TYPES.has(marker.type)) {
    return null;
  }
  const haystack = `${marker.name ?? ''} ${marker.type ?? ''}`.toLowerCase();
  if (WASTE.test(haystack)) {
    return 'waste';
  }
  return findPart(marker, haystack)?.id ?? null;
}

/**
 * Shorten a raw supply name to a widget label: drop a serial-number tail
 * ("Black Toner_S/N_:CRUM-..." -> "Black Toner"), then cut at 24 characters.
 * @param {string} name
 * @returns {string}
 */
function fitLabel(name) {
  const cleaned = name.replace(/[_ ]*s\/n.*$/i, '').trim() || name;
  return cleaned.length <= 24 ? cleaned : `${cleaned.slice(0, 23)}…`;
}

/**
 * Raw supply name without a serial-number tail, uncut.
 * @param {string} name
 * @returns {string}
 */
function cleanRawName(name) {
  const raw = String(name ?? '').trim();
  return raw.replace(/[_ ]*s\/n.*$/i, '').trim() || raw;
}

/**
 * Indexes of the names shared by several entries (case-insensitive), one
 * group per name, in the order of the list.
 * @param {string[]} names
 * @returns {number[][]}
 */
function sameNameGroups(names) {
  const groups = new Map();
  names.forEach((name, index) => {
    const id = name.toLowerCase();
    groups.set(id, [...(groups.get(id) ?? []), index]);
  });
  return [...groups.values()].filter((indexes) => indexes.length > 1);
}

/**
 * "Rouleau" -> "Rouleau 2", cut so that the whole stays within `max`.
 * @param {string} name
 * @param {number} rank
 * @param {number} max
 * @returns {string}
 */
function numbered(name, rank, max) {
  const suffix = ` ${rank}`;
  const room = max - suffix.length;
  const base = name.length <= room ? name : `${name.slice(0, room - 1)}…`;
  return `${base}${suffix}`;
}

/**
 * Tell apart the supplies of ONE printer that end up with the same name
 * (two SNMP rollers both "Rouleau"): with their cleaned raw names when
 * those differ, else with a number in the printer order ("Rouleau 1",
 * "Rouleau 2"). Deterministic for a given list of supplies; only names
 * change, never keys nor external_ids.
 * @param {Array<{ name: string }>} markers the supplies, in the printer order
 * @param {string[]} names their names, aligned with `markers`
 * @param {{ max: number, withRaw: (name: string, raw: string) => string }} options
 *   `withRaw` builds the name that carries the raw one
 * @returns {string[]} the names, aligned with `markers`
 */
function distinctNames(markers, names, { max, withRaw }) {
  const result = [...names];
  for (const indexes of sameNameGroups(names)) {
    const raws = indexes.map((i) => cleanRawName(markers[i].name));
    const candidates = indexes.map((i, n) => withRaw(names[i], raws[n]));
    const usable =
      indexes.every((i, n) => raws[n].toLowerCase() !== names[i].toLowerCase()) &&
      new Set(candidates.map((c) => c.toLowerCase())).size === candidates.length;
    indexes.forEach((i, n) => {
      result[i] = usable ? candidates[n] : numbered(names[i], n + 1, max);
    });
  }
  // A raw name may land on the name of another supply: number what still
  // collides (never seen, but a duplicate name would be frozen for good).
  for (const indexes of sameNameGroups(result)) {
    indexes.forEach((i, n) => {
      result[i] = numbered(result[i], n + 1, max);
    });
  }
  return result;
}

/**
 * Feature names of the supplies of one printer (displayMarkerName), made
 * distinct: "Rouleau (Roller A)", "Rouleau (Roller B)", or "Rouleau 1",
 * "Rouleau 2" when the raw names are the same.
 * @param {Array<{ name: string, type: string|null }>} markers in the printer order
 * @param {'printer'|'fr'|'en'} lang
 * @returns {string[]} aligned with `markers`
 */
export function displayMarkerNames(markers, lang) {
  return distinctNames(
    markers,
    markers.map((marker) => displayMarkerName(marker, lang)),
    { max: Infinity, withRaw: (name, raw) => `${name} (${raw})` },
  );
}

/**
 * Widget labels of the supplies of one printer (shortMarkerName, ≤ 24),
 * made distinct the same way: the shortened raw name, else a number.
 * @param {Array<{ name: string, type: string|null }>} markers in the printer order
 * @param {'printer'|'fr'|'en'} lang
 * @returns {string[]} aligned with `markers`
 */
export function shortMarkerNames(markers, lang) {
  return distinctNames(
    markers,
    markers.map((marker) => shortMarkerName(marker, lang)),
    { max: 24, withRaw: (_name, raw) => fitLabel(raw) },
  );
}
