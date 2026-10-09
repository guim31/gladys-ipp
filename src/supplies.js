// -----------------------------------------------------------------------------
// SNMP supplies (Printer MIB, RFC 3805 — the way CUPS reads ink levels), in
// two roles:
//   - fallback: IPP announces NO supply at all -> the SNMP table replaces it;
//   - complement: IPP announces its cartridges but not the printer PARTS
//     (drum/imaging unit, fuser, transfer belt, waste bottle) that lasers
//     list in the SNMP table -> those parts are APPENDED, the IPP markers are
//     never touched (their feature keys carry the history of created devices).
//
// Traffic discipline:
//   - only towards that printer's own address, in unicast;
//   - only when the LEVELS are due (not on every 15 s state sample);
//   - a printer that does not answer SNMP is left alone for SNMP_RETRY_MS, so
//     a firewalled or SNMP-less printer costs at most two unanswered datagrams
//     per hour;
//   - a printer that answers but has no part to add (an inkjet whose IPP
//     already lists everything) is left alone for SNMP_IDLE_RETRY_MS: its
//     table only changes with a hardware swap, a few walks a day are enough.
// Since the complement, a printer whose IPP levels work DOES generate SNMP
// packets — a handful a day when it has nothing to add, one table walk per
// levels reading when it does (that is the price of the drum level).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { buildMarkers, slugify } from './printer.js';
import { CARTRIDGE_TYPES, markerPart } from './naming.js';
import { readSnmpSupplies } from './snmp/supplies.js';

const logger = createLogger({ name: 'supplies' });

// Leave a printer that did not answer SNMP alone for this long.
export const SNMP_RETRY_MS = 30 * 60 * 1000;

// Leave a printer that answered SNMP with nothing to add alone for this long.
// Longer than SNMP_RETRY_MS: the answer was conclusive, not a lost datagram,
// and a part only appears in the table when one is fitted. Six hours still
// lets a newly fitted part show up the same day.
export const SNMP_IDLE_RETRY_MS = 6 * 60 * 60 * 1000;

// SNMP supply types that are printer parts, eligible for the complement.
// Same vocabulary as the IPP marker-types (see SUPPLY_TYPES).
export const PART_TYPES = new Set([
  'opc',
  'developer',
  'fuser',
  'transfer-unit',
  'cleaner-unit',
  'waste-toner',
  'waste-ink',
  'fuser-oil',
  'waste-water',
]);

// host -> { at, delay } of the last SNMP attempt that brought nothing.
const snmpMisses = new Map();

/** Reset the SNMP back-off (tests only). */
export function resetSupplyFallback() {
  snmpMisses.clear();
}

/**
 * Hostname of a printer URL, without the IPv6 brackets.
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  return new URL(url).hostname.replace(/^\[|\]$/g, '');
}

/**
 * Pick, among the SNMP supply rows, the printer parts IPP does not already
 * announce. Deliberately prudent — a duplicate feature would be frozen in
 * Gladys forever, a missed part only costs a gauge:
 *   - never a cartridge (toner, ink...): IPP covers those;
 *   - a part type (opc, fuser...), or an unknown/"other" type whose NAME is
 *     a recognized part (drum, imaging unit, fuser, belt, waste...);
 *   - skipped when an IPP marker has the same type, is the same part by
 *     name, or already uses the same key.
 * @param {Array<{ key: string, name: string, type: string|null }>} ippMarkers
 * @param {Array<{ name: string, type: string|null }>} snmpRows
 * @returns {Array<object>} rows to append, in the SNMP order
 */
export function complementRows(ippMarkers, snmpRows) {
  const ippTypes = new Set(ippMarkers.map((m) => m.type).filter(Boolean));
  const ippParts = new Set(ippMarkers.map(markerPart).filter(Boolean));
  const usedKeys = new Set(ippMarkers.map((m) => m.key));
  const rows = [];
  for (const row of snmpRows) {
    if (CARTRIDGE_TYPES.has(row.type)) {
      continue;
    }
    const part = markerPart(row);
    if (!PART_TYPES.has(row.type) && !part) {
      continue; // unknown type and unrecognized name: could be anything
    }
    if ((row.type && ippTypes.has(row.type)) || (part && ippParts.has(part))) {
      continue;
    }
    const key = slugify(row.name);
    if (usedKeys.has(key)) {
      continue;
    }
    usedKeys.add(key);
    rows.push(row);
  }
  return rows;
}

/**
 * Format markers for a log line.
 * @param {Array<{ name: string, percent: number|null, rawLevel: number|null }>} markers
 * @returns {string}
 */
function describe(markers) {
  return markers
    .map((m) => `${m.name}=${m.percent !== null ? `${m.percent}%` : `raw:${m.rawLevel}`}`)
    .join(', ');
}

/**
 * Complete a parsed printer with its SNMP supplies: all of them when IPP
 * announced none (fallback), the missing parts otherwise (complement).
 * Returns the printer unchanged when SNMP fails or brings nothing — never
 * fatal, and the IPP markers are never removed nor modified.
 * @param {{ markers: Array<object> }} printer parsed printer
 * @param {string} url working IPP URL of that printer
 * @param {{ readSupplies?: typeof readSnmpSupplies, now?: () => number,
 *           enabled?: boolean, ignoreBackoff?: boolean }} [deps] test seam;
 *           `ignoreBackoff` is for the manual test button (the user asked for
 *           a live answer, not a cached "we tried recently")
 * @returns {Promise<{ markers: Array<object>, supplySource?: 'snmp'|'ipp+snmp' }>}
 *   complement markers carry `source: 'snmp'`
 */
export async function withFallbackSupplies(printer, url, deps = {}) {
  const {
    readSupplies = readSnmpSupplies,
    now = Date.now,
    enabled = true,
    ignoreBackoff = false,
  } = deps;
  if (!enabled) {
    return printer;
  }

  let host;
  try {
    host = hostOf(url);
  } catch {
    return printer;
  }

  const miss = snmpMisses.get(host);
  if (!ignoreBackoff && miss !== undefined && now() - miss.at < miss.delay) {
    return printer;
  }

  let rows = [];
  try {
    rows = await readSupplies(host);
  } catch (err) {
    // A printer without SNMP is a normal situation, not an integration error.
    logger.debug(`SNMP supply read failed on ${host}: ${err.message}`);
  }

  if (rows.length === 0) {
    snmpMisses.set(host, { at: now(), delay: SNMP_RETRY_MS });
    if (printer.markers.length === 0) {
      logger.info(`${host} announces no supply over IPP nor SNMP`);
    } else {
      logger.debug(`${host}: no SNMP answer, IPP supplies only`);
    }
    return printer;
  }

  if (printer.markers.length === 0) {
    snmpMisses.delete(host);
    const markers = buildMarkers(rows);
    logger.info(`${host}: ${markers.length} supply(ies) read over SNMP (${describe(markers)})`);
    return { ...printer, markers, supplySource: 'snmp' };
  }

  const extra = buildMarkers(complementRows(printer.markers, rows), {
    takenKeys: printer.markers.map((m) => m.key),
  }).map((marker) => ({ ...marker, source: 'snmp' }));

  // Only a part with a known level is worth a table walk at every reading;
  // parts without one still show in the test button's diagnostic.
  if (extra.some((m) => m.percent !== null)) {
    snmpMisses.delete(host);
  } else {
    snmpMisses.set(host, { at: now(), delay: SNMP_IDLE_RETRY_MS });
  }
  if (extra.length === 0) {
    logger.debug(`${host}: SNMP lists no part IPP does not already announce`);
    return printer;
  }
  logger.info(`${host}: ${extra.length} part(s) added from SNMP (${describe(extra)})`);
  return { ...printer, markers: [...printer.markers, ...extra], supplySource: 'ipp+snmp' };
}
