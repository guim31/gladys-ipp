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
  if (/waste|maintenance[ -]?box/.test(haystack)) {
    if (/ink|encre|maintenance[ -]?box/.test(haystack)) {
      return lang === 'fr' ? "Bac de récupération d'encre" : 'Waste ink container';
    }
    return lang === 'fr' ? 'Récupérateur de toner' : 'Waste container';
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

  if (/waste|maintenance[ -]?box/.test(haystack)) {
    return lang === 'fr' ? 'Récupérateur' : 'Waste';
  }
  const part = PARTS.find((p) => p.match.test(haystack));
  if (part) {
    if (!colorName) {
      return part[lang];
    }
    return lang === 'fr' ? `${part.fr} ${colorName.toLowerCase()}` : `${colorName} ${part.en}`;
  }
  return colorName ?? fitLabel(raw);
}

// Printer parts that are not cartridges but do report a level over IPP/SNMP.
const PARTS = [
  { match: /drum|tambour|opc|imaging[ -]?unit/, en: 'Drum', fr: 'Tambour' },
  { match: /fuser|fixing|four/, en: 'Fuser', fr: 'Four' },
  { match: /transfer|belt|courroie/, en: 'Transfer', fr: 'Transfert' },
  { match: /roller|rouleau/, en: 'Roller', fr: 'Rouleau' },
];

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
