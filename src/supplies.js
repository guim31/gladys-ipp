// -----------------------------------------------------------------------------
// Supply fallback: when IPP announces no supply at all, ask the printer over
// SNMP (Printer MIB, RFC 3805) — the way CUPS reads ink levels.
//
// Traffic discipline, deliberately strict:
//   - only for a printer that answered IPP and announced NO supply (a printer
//     whose levels already work never generates a single SNMP packet);
//   - only towards that printer's own address, in unicast;
//   - only when the LEVELS are due (not on every 15 s state sample);
//   - a printer that does not answer SNMP is remembered and left alone for
//     SNMP_RETRY_MS, so a firewalled or SNMP-less printer costs at most two
//     unanswered datagrams per hour.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { buildMarkers } from './printer.js';
import { readSnmpSupplies } from './snmp/supplies.js';

const logger = createLogger({ name: 'supplies' });

// Leave a printer that did not answer SNMP alone for this long.
export const SNMP_RETRY_MS = 30 * 60 * 1000;

// host -> timestamp of the last SNMP attempt that found nothing.
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
 * Complete a parsed printer with its SNMP supplies when IPP announced none.
 * Returns the printer unchanged in every other case — including when SNMP
 * fails, which is never fatal: the state feature keeps working.
 * @param {{ markers: Array<object> }} printer parsed printer
 * @param {string} url working IPP URL of that printer
 * @param {{ readSupplies?: typeof readSnmpSupplies, now?: () => number,
 *           enabled?: boolean, ignoreBackoff?: boolean }} [deps] test seam;
 *           `ignoreBackoff` is for the manual test button (the user asked for
 *           a live answer, not a cached "we tried recently")
 * @returns {Promise<{ markers: Array<object>, supplySource?: string }>}
 */
export async function withFallbackSupplies(printer, url, deps = {}) {
  const {
    readSupplies = readSnmpSupplies,
    now = Date.now,
    enabled = true,
    ignoreBackoff = false,
  } = deps;
  if (!enabled || printer.markers.length > 0) {
    return printer;
  }

  let host;
  try {
    host = hostOf(url);
  } catch {
    return printer;
  }

  const lastMiss = snmpMisses.get(host);
  if (!ignoreBackoff && lastMiss !== undefined && now() - lastMiss < SNMP_RETRY_MS) {
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
    snmpMisses.set(host, now());
    logger.info(`${host} announces no supply over IPP nor SNMP`);
    return printer;
  }

  snmpMisses.delete(host);
  const markers = buildMarkers(rows);
  logger.info(
    `${host}: ${markers.length} supply(ies) read over SNMP ` +
      `(${markers.map((m) => `${m.name}=${m.percent !== null ? `${m.percent}%` : `raw:${m.rawLevel}`}`).join(', ')})`,
  );
  return { ...printer, markers, supplySource: 'snmp' };
}
