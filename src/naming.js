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
