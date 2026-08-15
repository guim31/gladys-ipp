// -----------------------------------------------------------------------------
// Printer model: turn raw IPP attributes into a small, typed object the rest
// of the code manipulates (markers = ink/toner supplies, state, identity).
// -----------------------------------------------------------------------------

import { PRINTER_STATES } from './ipp/constants.js';

/**
 * IPP 1setOf helper: an attribute with a single value is decoded as a scalar,
 * with several values as an array. Normalize to an array.
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Slugify a label into a stable, id-friendly token.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'unknown' : slug;
}

/**
 * Convert a raw marker level to a percentage.
 * IPP semantics: -1 = not reported, -2 = unknown, -3 = "at least one unit
 * left"; positive values are relative to marker-high-levels (usually 100).
 * @param {unknown} level
 * @param {unknown} high
 * @returns {number|null} 0-100, or null when the printer does not report it
 */
export function markerPercent(level, high) {
  const rawLevel = Number(level);
  if (!Number.isFinite(rawLevel) || rawLevel < 0) {
    return null;
  }
  const rawHigh = Number(high);
  const scale = Number.isFinite(rawHigh) && rawHigh > 0 ? rawHigh : 100;
  return Math.max(0, Math.min(100, Math.round((rawLevel * 100) / scale)));
}

/**
 * Parse one printer-supply octetString (PWG 5100.13) into its fields.
 * The value is a list of "key=value;" pairs, e.g.
 * "index=1;class=supplyThatIsConsumed;type=ink;unit=percent;
 *  maxcapacity=100;level=57;colorantname=cyan;".
 * @param {unknown} value
 * @returns {Record<string, string>} lowercased keys
 */
export function parseSupplyEntry(value) {
  const fields = {};
  for (const part of String(value ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    }
  }
  return fields;
}

/**
 * Build marker rows from the printer-supply / printer-supply-description
 * attributes (PWG 5100.13) — the OTHER standard way of announcing supplies.
 * Several firmwares (Epson EcoTank...) implement only this one and never
 * send the marker-* attributes.
 * @param {Record<string, unknown>} attributes
 * @returns {Array<{ name: string, color: string|null, type: string|null,
 *                   level: unknown, high: unknown }>}
 */
function supplyRows(attributes) {
  const supplies = asArray(attributes['printer-supply']);
  const descriptions = asArray(attributes['printer-supply-description']);
  const count = Math.max(supplies.length, descriptions.length);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const fields = supplies[i] != null ? parseSupplyEntry(supplies[i]) : {};
    const description = descriptions[i] != null ? String(descriptions[i]).trim() : '';
    rows.push({
      name: description !== '' ? description : (fields.colorantname ?? ''),
      color: fields.colorantname ?? null,
      type: fields.type ?? null,
      level: fields.level,
      high: fields.maxcapacity,
    });
  }
  return rows;
}

/**
 * Turn raw supply rows into the integration's marker model, whatever their
 * source (IPP marker-*, IPP printer-supply, or the SNMP Printer MIB).
 * @param {Array<{ name?: string, color?: string|null, type?: string|null,
 *                 level?: unknown, high?: unknown }>} rows
 * @returns {Array<{ key: string, name: string, color: string|null,
 *                   type: string|null, percent: number|null, rawLevel: number|null }>}
 */
export function buildMarkers(rows) {
  const usedKeys = new Set();
  return rows.map((row, i) => {
    const name = row.name != null && row.name !== '' ? String(row.name) : `Cartridge ${i + 1}`;
    // Feature keys derive from the supply NAME (stable across reboots and
    // list reorderings), deduplicated by suffix when two supplies share one.
    let key = slugify(name);
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${slugify(name)}-${suffix}`;
      suffix += 1;
    }
    usedKeys.add(key);
    const rawLevel = Number(row.level);
    return {
      key,
      name,
      color: row.color ?? null,
      type: row.type ?? null,
      percent: markerPercent(row.level, row.high),
      // Raw level value, kept for diagnostics: when percent is null, it
      // tells WHY (-1 not reported, -2 unknown, -3 "some left" — the IPP
      // sentinels, shared with the Printer MIB — or null when the value is
      // simply missing).
      rawLevel: Number.isFinite(rawLevel) ? rawLevel : null,
    };
  });
}

/**
 * Clean up printer-state-reasons: drop 'none', strip the severity suffix
 * ('media-empty-warning' -> 'media-empty'), dedupe.
 * @param {unknown} reasons
 * @returns {string[]}
 */
export function cleanStateReasons(reasons) {
  const cleaned = asArray(reasons)
    .map((reason) =>
      String(reason)
        .trim()
        .replace(/-(report|warning|error)$/, ''),
    )
    .filter((reason) => reason !== '' && reason !== 'none');
  return [...new Set(cleaned)];
}

/**
 * Parse the merged printer attributes into the integration's printer model.
 * @param {Record<string, unknown>} attributes
 * @returns {{
 *   uuid: string|null,
 *   name: string|null,
 *   makeAndModel: string|null,
 *   location: string|null,
 *   state: string,
 *   stateReasons: string[],
 *   stateText: string,
 *   markers: Array<{ key: string, name: string, color: string|null,
 *                    type: string|null, percent: number|null }>,
 * }}
 */
export function parsePrinter(attributes) {
  const uuidRaw = attributes['printer-uuid'];
  const uuid =
    typeof uuidRaw === 'string' && uuidRaw.trim() !== ''
      ? uuidRaw.trim().replace(/^urn:uuid:/i, '')
      : null;

  const state = PRINTER_STATES[Number(attributes['printer-state'])] ?? 'unknown';
  const stateReasons = cleanStateReasons(attributes['printer-state-reasons']);
  const stateText = stateReasons.length > 0 ? `${state} (${stateReasons.join(', ')})` : state;

  const names = asArray(attributes['marker-names']);
  const levels = asArray(attributes['marker-levels']);
  const colors = asArray(attributes['marker-colors']);
  const types = asArray(attributes['marker-types']);
  const highs = asArray(attributes['marker-high-levels']);

  const markerCount = Math.max(names.length, levels.length);
  let rows = [];
  for (let i = 0; i < markerCount; i += 1) {
    rows.push({
      name: names[i] != null ? String(names[i]) : '',
      color: colors[i] != null ? String(colors[i]) : null,
      type: types[i] != null ? String(types[i]) : null,
      level: levels[i],
      high: highs[i],
    });
  }
  if (rows.length === 0) {
    // No marker-* attributes at all: fall back to the printer-supply pair.
    // marker-* stays preferred when both exist (richer, and the feature keys
    // of already-created devices derive from it).
    rows = supplyRows(attributes);
  }

  const markers = buildMarkers(rows);

  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

  return {
    uuid,
    name: text(attributes['printer-name']),
    makeAndModel: text(attributes['printer-make-and-model']),
    location: text(attributes['printer-location']),
    state,
    stateReasons,
    stateText,
    markers,
  };
}
