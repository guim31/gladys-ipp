// -----------------------------------------------------------------------------
// Display names of the device features.
//
// Printers report their supplies in their own words — almost always English,
// lowercase, sometimes decorated with serial numbers ("Black
// Toner_S/N_:CRUM-25111822430"). Gladys features carry a single name (no
// multi-language), so the target language is a configuration choice
// (feature_names: 'printer' | 'fr' | 'en' | 'de' | 'es').
//
// Translation works by keyword detection on the raw marker name + type, and
// NEVER touches the feature keys/external_ids (they stay derived from the raw
// name, so translated devices keep the same features and history).
// -----------------------------------------------------------------------------

// Detected color, from the raw marker name. Order matters: the composite
// shades must match before the plain colors they contain.
// `frM`/`frF` and `esM`/`esF` are the masculine and feminine adjectives;
// German puts the color noun after the kind ("Toner Schwarz"), no agreement.
const COLORS = [
  {
    match: /photo[ -]?black/,
    en: 'Photo black',
    frM: 'noir photo',
    frF: 'noire photo',
    de: 'Fotoschwarz',
    esM: 'negro foto',
    esF: 'negra foto',
  },
  {
    match: /matte[ -]?black/,
    en: 'Matte black',
    frM: 'noir mat',
    frF: 'noire mate',
    de: 'Mattschwarz',
    esM: 'negro mate',
    esF: 'negra mate',
  },
  {
    match: /light[ -]?cyan/,
    en: 'Light cyan',
    frM: 'cyan clair',
    frF: 'cyan clair',
    de: 'Hellcyan',
    esM: 'cian claro',
    esF: 'cian claro',
  },
  {
    match: /light[ -]?magenta/,
    en: 'Light magenta',
    frM: 'magenta clair',
    frF: 'magenta clair',
    de: 'Hellmagenta',
    esM: 'magenta claro',
    esF: 'magenta claro',
  },
  {
    match: /black|noir/,
    en: 'Black',
    frM: 'noir',
    frF: 'noire',
    de: 'Schwarz',
    esM: 'negro',
    esF: 'negra',
  },
  { match: /cyan/, en: 'Cyan', frM: 'cyan', frF: 'cyan', de: 'Cyan', esM: 'cian', esF: 'cian' },
  {
    match: /magenta/,
    en: 'Magenta',
    frM: 'magenta',
    frF: 'magenta',
    de: 'Magenta',
    esM: 'magenta',
    esF: 'magenta',
  },
  {
    match: /yellow|jaune/,
    en: 'Yellow',
    frM: 'jaune',
    frF: 'jaune',
    de: 'Gelb',
    esM: 'amarillo',
    esF: 'amarilla',
  },
  {
    match: /gr[ae]y|gris/,
    en: 'Gray',
    frM: 'gris',
    frF: 'grise',
    de: 'Grau',
    esM: 'gris',
    esF: 'gris',
  },
  {
    match: /tri-?colou?r|colou?r/,
    en: 'Tri-color',
    frM: 'trois couleurs',
    frF: 'trois couleurs',
    de: 'Dreifarbig',
    esM: 'tricolor',
    esF: 'tricolor',
  },
];

/** Languages the feature names can be translated to (config.feature_names). */
export const NAME_LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Whether the feature names are translated ('printer' keeps the raw ones).
 * @param {string} lang
 * @returns {boolean}
 */
function translated(lang) {
  return NAME_LANGUAGES.includes(lang);
}

// Waste containers, feature names and widget labels.
const WASTE_NAMES = {
  ink: {
    en: 'Waste ink container',
    fr: "Bac de récupération d'encre",
    de: 'Resttintenbehälter',
    es: 'Depósito de tinta residual',
  },
  toner: {
    en: 'Waste container',
    fr: 'Récupérateur de toner',
    de: 'Resttonerbehälter',
    es: 'Depósito de tóner residual',
  },
  short: { en: 'Waste', fr: 'Récupérateur', de: 'Restbehälter', es: 'Residuos' },
};

/**
 * Best-effort display name of a supply, in the requested language.
 * 'printer' (the default) returns the raw name untouched; 'en'/'fr'/'de'/'es' build a
 * clean "<kind> <color>" label when a color is recognized, and fall back to
 * the raw name otherwise (never worse than today).
 * @param {{ name: string, type: string|null }} marker parsed marker
 * @param {'printer'|'en'|'fr'|'de'|'es'} lang
 * @returns {string}
 */
export function displayMarkerName(marker, lang) {
  if (!translated(lang)) {
    return marker.name;
  }
  const haystack = `${marker.name} ${marker.type ?? ''}`.toLowerCase();
  const color = COLORS.find((c) => c.match.test(haystack));

  // Waste containers have no color but a very recognizable name. Inkjets
  // call theirs a maintenance box, laser printers a waste toner bottle.
  if (WASTE.test(haystack)) {
    if (/ink|encre|maintenance[ -]?box/.test(haystack)) {
      return WASTE_NAMES.ink[lang];
    }
    return WASTE_NAMES.toner[lang];
  }
  // Printer parts (drum, imaging unit, fuser...) used to fall through to the
  // cartridge rule below ("Black Drum Unit" became "Encre noire"). Feature
  // names are frozen at creation, so this only names NEW features right.
  const part = findPart(marker, haystack);
  if (part?.id === 'roller') {
    return rollerName(haystack, lang, 'long');
  }
  if (part) {
    const long = part.long[lang];
    if (!color) {
      return long;
    }
    if (lang === 'fr') {
      return `${long} ${part.feminine?.fr ? color.frF : color.frM}`;
    }
    if (lang === 'es') {
      return `${long} ${part.feminine?.es ? color.esF : color.esM}`;
    }
    if (lang === 'de') {
      return `${long} ${color.de}`;
    }
    return `${color.en} ${long.toLowerCase()}`;
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
  if (lang === 'de') {
    return `${isToner ? 'Toner' : 'Tinte'} ${color.de}`;
  }
  // French and Spanish: the kind carries the grammatical gender of the
  // color adjective.
  if (lang === 'es') {
    return isToner ? `Tóner ${color.esM}` : `Tinta ${color.esF}`;
  }
  if (isToner) {
    return `Toner ${color.frM}`;
  }
  return `Encre ${color.frF}`;
}

/**
 * Display name of the printer state feature.
 * @param {'printer'|'en'|'fr'|'de'|'es'} lang
 * @returns {string}
 */
export function displayStateName(lang) {
  return STATE_NAMES[lang] ?? STATE_NAMES.en;
}

const STATE_NAMES = { en: 'State', fr: 'État', de: 'Status', es: 'Estado' };

// Short color names for the dashboard widgets (a gauge label holds 24
// characters): the color alone, the kind only when it is not a cartridge.
const SHORT_COLORS = {
  'Photo black': { en: 'Photo black', fr: 'Noir photo', de: 'Fotoschwarz', es: 'Negro foto' },
  'Matte black': { en: 'Matte black', fr: 'Noir mat', de: 'Mattschwarz', es: 'Negro mate' },
  'Light cyan': { en: 'Light cyan', fr: 'Cyan clair', de: 'Hellcyan', es: 'Cian claro' },
  'Light magenta': {
    en: 'Light magenta',
    fr: 'Magenta clair',
    de: 'Hellmagenta',
    es: 'Magenta claro',
  },
  Black: { en: 'Black', fr: 'Noir', de: 'Schwarz', es: 'Negro' },
  Cyan: { en: 'Cyan', fr: 'Cyan', de: 'Cyan', es: 'Cian' },
  Magenta: { en: 'Magenta', fr: 'Magenta', de: 'Magenta', es: 'Magenta' },
  Yellow: { en: 'Yellow', fr: 'Jaune', de: 'Gelb', es: 'Amarillo' },
  Gray: { en: 'Gray', fr: 'Gris', de: 'Grau', es: 'Gris' },
  'Tri-color': { en: 'Tri-color', fr: 'Trois couleurs', de: 'Dreifarbig', es: 'Tricolor' },
};

/**
 * Short display name of a supply for a widget tile (≤ 24 characters): the
 * color alone for an ink or toner cartridge ("Noir", "Cyan"), the part for
 * the others ("Tambour", "Four", "Récupérateur"). 'printer' keeps the raw
 * name, shortened. Never empty.
 * @param {{ name: string, type: string|null }} marker parsed marker
 * @param {'printer'|'en'|'fr'|'de'|'es'} lang language of the feature names
 * @returns {string}
 */
export function shortMarkerName(marker, lang) {
  const raw = String(marker.name ?? '').trim() || 'Cartridge';
  if (!translated(lang)) {
    return fitLabel(raw);
  }
  const haystack = `${raw} ${marker.type ?? ''}`.toLowerCase();
  const color = COLORS.find((c) => c.match.test(haystack));
  const colorName = color ? SHORT_COLORS[color.en][lang] : null;

  if (WASTE.test(haystack)) {
    return WASTE_NAMES.short[lang];
  }
  const part = findPart(marker, haystack);
  if (part?.id === 'roller') {
    return rollerName(haystack, lang, 'short');
  }
  if (part) {
    const short = part.short[lang];
    if (!colorName) {
      return short;
    }
    if (lang === 'fr') {
      return fitLabel(`${short} ${colorName.toLowerCase()}`);
    }
    if (lang === 'es') {
      return fitLabel(`${short} ${part.feminine?.esShort ? color.esF : color.esM}`);
    }
    if (lang === 'de') {
      return fitLabel(`${short} ${colorName}`);
    }
    return fitLabel(`${colorName} ${short}`);
  }
  return colorName ?? fitLabel(raw);
}

// Waste containers: a laser's waste toner bottle, an inkjet's maintenance box.
const WASTE = /waste|maintenance[ -]?box|r[ée]cup[ée]rat/;

// Printer parts that are not cartridges but do report a level over IPP/SNMP.
// `short` are the widget labels, `long` the feature names; `feminine` drives
// the color adjective (French and Spanish feature names, `esShort` for the
// Spanish widget labels). `id` identifies the part across sources (an IPP
// "Drum" and an SNMP "Imaging Unit" are the same one).
// Order matters: the imaging unit must match before the plain drum.
const PARTS = [
  {
    id: 'drum',
    match: /imaging[ -]?unit|unit[ée] d'imagerie/,
    short: { en: 'Drum', fr: 'Tambour', de: 'Trommel', es: 'Tambor' },
    long: {
      en: 'Imaging unit',
      fr: "Unité d'imagerie",
      de: 'Bildeinheit',
      es: 'Unidad de imagen',
    },
    feminine: { fr: true, es: true },
  },
  {
    id: 'drum',
    match: /drum|tambour|\bopc\b|photoconduct/,
    short: { en: 'Drum', fr: 'Tambour', de: 'Trommel', es: 'Tambor' },
    long: { en: 'Drum', fr: 'Tambour', de: 'Trommel', es: 'Tambor' },
  },
  {
    id: 'developer',
    match: /develop|d[ée]veloppe/,
    short: { en: 'Developer', fr: 'Développeur', de: 'Entwickler', es: 'Revelador' },
    long: { en: 'Developer', fr: 'Développeur', de: 'Entwickler', es: 'Revelador' },
  },
  {
    id: 'fuser',
    match: /fuser|fixing|four/,
    short: { en: 'Fuser', fr: 'Four', de: 'Fixiereinheit', es: 'Fusor' },
    long: { en: 'Fuser', fr: 'Four', de: 'Fixiereinheit', es: 'Fusor' },
  },
  {
    id: 'transfer',
    match: /transfer|belt|courroie/,
    short: { en: 'Transfer', fr: 'Transfert', de: 'Transfer', es: 'Transferencia' },
    long: {
      en: 'Transfer unit',
      fr: 'Unité de transfert',
      de: 'Transfereinheit',
      es: 'Unidad de transferencia',
    },
    feminine: { fr: true, es: true, esShort: true },
  },
  {
    id: 'cleaner',
    match: /clean|nettoyage/,
    short: { en: 'Cleaner', fr: 'Nettoyage', de: 'Reinigung', es: 'Limpieza' },
    long: {
      en: 'Cleaning unit',
      fr: 'Unité de nettoyage',
      de: 'Reinigungseinheit',
      es: 'Unidad de limpieza',
    },
    feminine: { fr: true, es: true, esShort: true },
  },
  {
    id: 'roller',
    match: /roller|rouleau/,
    short: { en: 'Roller', fr: 'Rouleau', de: 'Walze', es: 'Rodillo' },
    long: { en: 'Roller', fr: 'Rouleau', de: 'Walze', es: 'Rodillo' },
  },
];

// What a roller does, from its raw name. A laser lists several rollers in
// its SNMP table (pickup, separation...) that would all be "Rouleau".
// "Transfer Roller" never gets here: the transfer part matches first.
// `short` qualifies the roller on a tile, `long` is the whole feature name.
const ROLLER_KINDS = [
  {
    match: /pick[ _-]?up|prise/,
    short: { en: 'Pickup', fr: 'prise', de: 'Einzug', es: 'recogida' },
    long: {
      en: 'Pickup roller',
      fr: 'Rouleau de prise papier',
      de: 'Einzugswalze',
      es: 'Rodillo de recogida',
    },
  },
  {
    match: /retard|s[ée]paration/,
    short: { en: 'Separation', fr: 'séparation', de: 'Trennung', es: 'separación' },
    long: {
      en: 'Separation roller',
      fr: 'Rouleau de séparation',
      de: 'Trennwalze',
      es: 'Rodillo de separación',
    },
  },
  {
    match: /feed|entra[iî]nement/,
    short: { en: 'Feed', fr: 'entraînement', de: 'Transport', es: 'alimentación' },
    long: {
      en: 'Feed roller',
      fr: "Rouleau d'entraînement",
      de: 'Transportwalze',
      es: 'Rodillo de alimentación',
    },
  },
];

/**
 * The paper tray a supply belongs to, from its raw name: "Tray1", "Tray 2",
 * "Cassette 1", or the multipurpose / manual / bypass tray ("MP", "MPT").
 * @param {string} haystack lowercased "name type"
 * @returns {{ short: Record<string, string>, long: Record<string, string> }|null}
 */
function trayOf(haystack) {
  const numbered = /(?:tray|bac|cassette)[ _-]?(\d+)/.exec(haystack);
  if (numbered) {
    const n = numbered[1];
    const name = { en: `tray ${n}`, fr: `bac ${n}`, de: `Fach ${n}`, es: `bandeja ${n}` };
    return { short: name, long: name };
  }
  if (/\bmpt?\b|multi[ _-]?purpose|multifonction|manual|bypass/.test(haystack)) {
    return {
      short: { en: 'MP tray', fr: 'bac MF', de: 'MZ-Fach', es: 'bandeja MP' },
      long: {
        en: 'multipurpose tray',
        fr: 'bac multifonction',
        de: 'Mehrzweckfach',
        es: 'bandeja multipropósito',
      },
    };
  }
  return null;
}

/**
 * Name of a roller with its qualifiers: "Rouleau prise bac 1" on a tile,
 * "Rouleau de prise papier (bac 1)" as a feature name. A tile label that
 * would pass 24 characters drops the word "roller" ("Séparation bac MF").
 * @param {string} haystack lowercased "name type"
 * @param {'en'|'fr'|'de'|'es'} lang
 * @param {'short'|'long'} form
 * @returns {string}
 */
function rollerName(haystack, lang, form) {
  const kind = ROLLER_KINDS.find((k) => k.match.test(haystack));
  const tray = trayOf(haystack);
  const roller = ROLLER_NAMES[lang];
  if (form === 'long') {
    const base = kind ? kind.long[lang] : roller;
    return tray ? `${base} (${tray.long[lang]})` : base;
  }
  const qualifier = [kind?.short[lang], tray?.short[lang]].filter(Boolean).join(' ');
  if (!qualifier) {
    return roller;
  }
  let full;
  if (lang === 'fr' || lang === 'es') {
    full = `${roller} ${qualifier}`;
  } else if (lang === 'de') {
    // German compounds the kind ("Einzugswalze Fach 1").
    full = kind
      ? [kind.long.de, tray?.short.de].filter(Boolean).join(' ')
      : `Walze ${tray.short.de}`;
  } else {
    full = kind
      ? `${kind.short.en} roller${tray ? ` ${tray.short.en}` : ''}`
      : `Roller ${tray.short.en}`;
  }
  if (full.length <= 24) {
    return full;
  }
  return fitLabel(qualifier.charAt(0).toUpperCase() + qualifier.slice(1));
}

const ROLLER_NAMES = { en: 'Roller', fr: 'Rouleau', de: 'Walze', es: 'Rodillo' };

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
 * @param {'printer'|'en'|'fr'|'de'|'es'} lang
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
 * @param {'printer'|'en'|'fr'|'de'|'es'} lang
 * @returns {string[]} aligned with `markers`
 */
export function shortMarkerNames(markers, lang) {
  return distinctNames(
    markers,
    markers.map((marker) => shortMarkerName(marker, lang)),
    { max: 24, withRaw: (_name, raw) => fitLabel(raw) },
  );
}

/** Translation tables of the names, exported for the translation tests. */
export const NAMING_TEXTS = {
  colors: COLORS,
  shortColors: SHORT_COLORS,
  waste: WASTE_NAMES,
  state: STATE_NAMES,
  roller: ROLLER_NAMES,
  parts: PARTS,
  rollerKinds: ROLLER_KINDS,
};
