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

  const count = Math.max(names.length, levels.length);
  const usedKeys = new Set();
  const markers = [];
  for (let i = 0; i < count; i += 1) {
    const name = names[i] != null && names[i] !== '' ? String(names[i]) : `Cartridge ${i + 1}`;
    // Feature keys derive from the supply NAME (stable across reboots and
    // list reorderings), deduplicated by suffix when two supplies share one.
    let key = slugify(name);
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${slugify(name)}-${suffix}`;
      suffix += 1;
    }
    usedKeys.add(key);
    const rawLevel = Number(levels[i]);
    markers.push({
      key,
      name,
      color: colors[i] != null ? String(colors[i]) : null,
      type: types[i] != null ? String(types[i]) : null,
      percent: markerPercent(levels[i], highs[i]),
      // Raw marker-levels value, kept for diagnostics: when percent is null,
      // it tells WHY (-1 not reported, -2 unknown, -3 "some left" — the IPP
      // sentinels — or null when the value is simply missing from the array).
      rawLevel: Number.isFinite(rawLevel) ? rawLevel : null,
    });
  }

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
