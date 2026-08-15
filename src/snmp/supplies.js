// -----------------------------------------------------------------------------
// Printer MIB (RFC 3805) supply reading over SNMP.
//
// The prtMarkerSupplies table is THE universal way of reading ink/toner
// levels: it is what CUPS queries, and printers that announce nothing over
// IPP usually fill it in properly.
//
//   prtMarkerSuppliesType        .5   enum (toner, ink, wasteInk...)
//   prtMarkerSuppliesDescription .6   human-readable supply name
//   prtMarkerSuppliesMaxCapacity .8   scale of the level (-1/-2 = unknown)
//   prtMarkerSuppliesLevel       .9   current level (same -1/-2/-3 sentinels
//                                     as the IPP marker-levels attribute)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { snmpWalk } from './client.js';

const logger = createLogger({ name: 'snmp-supplies' });

const PRT_MARKER_SUPPLIES = '1.3.6.1.2.1.43.11.1.1';

export const SUPPLY_COLUMNS = {
  type: `${PRT_MARKER_SUPPLIES}.5`,
  description: `${PRT_MARKER_SUPPLIES}.6`,
  maxCapacity: `${PRT_MARKER_SUPPLIES}.8`,
  level: `${PRT_MARKER_SUPPLIES}.9`,
};

// prtMarkerSuppliesTypeTC, mapped to the same vocabulary as the IPP
// marker-types keywords so the display-name translation works unchanged.
export const SUPPLY_TYPES = {
  3: 'toner',
  4: 'waste-toner',
  5: 'ink',
  6: 'ink-cartridge',
  7: 'ink-ribbon',
  8: 'waste-ink',
  9: 'opc',
  10: 'developer',
  11: 'fuser-oil',
  15: 'fuser',
  18: 'cleaner-unit',
  20: 'transfer-unit',
  21: 'toner-cartridge',
  24: 'waste-water',
};

/**
 * Row index of an OID inside a table column ('...43.11.1.1.9.1.4' -> '1.4').
 * @param {string} oid
 * @param {string} column
 * @returns {string}
 */
function rowIndex(oid, column) {
  return oid.slice(column.length + 1);
}

/**
 * Read the supply table of a printer over SNMP.
 * Returns rows in the shape src/printer.js builds its markers from, so an
 * SNMP-sourced supply is indistinguishable from an IPP one downstream.
 * @param {string} host printer IP or hostname
 * @param {{ community?: string, timeoutMs?: number, walk?: typeof snmpWalk }} [options]
 * @returns {Promise<Array<{ name: string, color: string|null, type: string|null,
 *                           level: unknown, high: unknown }>>}
 */
export async function readSnmpSupplies(host, options = {}) {
  const { walk = snmpWalk, ...walkOptions } = options;

  // The level column decides which rows exist: a supply without a level is
  // of no use to us.
  const levels = await walk(host, SUPPLY_COLUMNS.level, walkOptions);
  if (levels.length === 0) {
    logger.debug(`No prtMarkerSuppliesLevel row on ${host}`);
    return [];
  }
  const [descriptions, maxCapacities, types] = await Promise.all([
    walk(host, SUPPLY_COLUMNS.description, walkOptions),
    walk(host, SUPPLY_COLUMNS.maxCapacity, walkOptions),
    walk(host, SUPPLY_COLUMNS.type, walkOptions),
  ]);

  const byIndex = (rows, column) =>
    new Map(rows.map((row) => [rowIndex(row.oid, column), row.value]));
  const descriptionByIndex = byIndex(descriptions, SUPPLY_COLUMNS.description);
  const maxByIndex = byIndex(maxCapacities, SUPPLY_COLUMNS.maxCapacity);
  const typeByIndex = byIndex(types, SUPPLY_COLUMNS.type);

  const supplies = levels.map((row) => {
    const index = rowIndex(row.oid, SUPPLY_COLUMNS.level);
    const description = descriptionByIndex.get(index);
    const typeCode = Number(typeByIndex.get(index));
    return {
      name: typeof description === 'string' && description !== '' ? description : `Supply ${index}`,
      // The Printer MIB carries the colorant in a separate table; the
      // description ("Black ink", "Cyan") is what naming.js reads anyway.
      color: null,
      type: SUPPLY_TYPES[typeCode] ?? null,
      level: row.value,
      high: maxByIndex.get(index),
    };
  });
  logger.info(`SNMP: ${supplies.length} supply row(s) read from ${host}`);
  return supplies;
}
