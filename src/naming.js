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
