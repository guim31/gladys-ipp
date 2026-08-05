// -----------------------------------------------------------------------------
// Printer device: build the Gladys discovery payload and publish the states.
//
// One Gladys device per printer:
//   - one LEVEL_SENSOR feature (0-100 %) per ink/toner supply ("marker");
//   - one TEXT feature with the printer state ('idle', 'printing',
//     'stopped (media-empty)', ...).
//
// The working IPP URL is stored in the device params (PRINTER_URL), so
// polling still works after a Gladys restart without re-running a discovery.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { getPrinterAttributes } from './ipp/client.js';
import { parsePrinter, slugify } from './printer.js';

export const DEVICE_TYPE = 'printer';
export const PRINTER_URL_PARAM = 'PRINTER_URL';
export const STATE_FEATURE_KEY = 'state';

// Gladys only accepts poll_frequency values from its own list (in ms):
// [60000, 30000, 15000, 10000, 2000, 1000]. One minute is the slowest, so the
// device is declared at 60000 and pollPrinter throttles the ACTUAL IPP
// requests down to the user's configured interval (config.poll_frequency, s).
export const DEVICE_POLL_FREQUENCY_MS = 60_000;

// Timestamp of the last successful IPP query, per device external_id.
const lastPollAt = new Map();

/** Reset the poll throttle (tests only). */
export function resetPollThrottle() {
  lastPollAt.clear();
}

const logger = createLogger({ name: 'printer-device' });

/**
 * Unique, stable platform id of a printer.
 * Modern printers report printer-uuid; without it, fall back to the hostname
 * of the working URL (documented limitation: use a fixed IP or a DNS name).
 * @param {{ uuid: string|null }} printer
 * @param {string} url working HTTP URL of the printer
 * @returns {string}
 */
export function platformIdFor(printer, url) {
  if (printer.uuid) {
    return printer.uuid;
  }
  return `host-${slugify(new URL(url).hostname)}`;
}

/**
 * Human-friendly device name.
 * @param {{ makeAndModel: string|null, name: string|null }} printer
 * @param {string} url
 * @returns {string}
 */
function deviceName(printer, url) {
  return printer.makeAndModel ?? printer.name ?? `Printer ${new URL(url).hostname}`;
}

/**
 * Build the Gladys discovery payload for one probed printer.
 * @param {object} gladys SDK instance
 * @param {{ printer: object, url: string }} probed
 * @param {object} _config reserved (device shape no longer depends on it)
 */
export function buildPrinterDevice(gladys, { printer, url }, _config) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformIdFor(printer, url));
  const features = [
    {
      name: 'State',
      external_id: ids.feature(STATE_FEATURE_KEY),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    ...printer.markers
      .filter((marker) => marker.percent !== null)
      .map((marker) => ({
        name: marker.name,
        external_id: ids.feature(`marker:${marker.key}`),
        category: DEVICE_FEATURE_CATEGORIES.LEVEL_SENSOR,
        // A supply level IS a level expressed as a percentage. This type also
        // drives the UI icon: Gladys maps level-sensor icons per TYPE, and
        // the generic sensor/integer type has no entry, so it rendered with
        // no icon at all. liquid-level-percent shows the droplet.
        type: DEVICE_FEATURE_TYPES.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true, // draw the consumption curve over time
      })),
  ];

  return {
    name: deviceName(printer, url),
    external_id: ids.device,
    // Gladys only schedules a poll when should_poll is true: without it the
    // device is created with the column default (false) and never polled.
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCY_MS,
    params: [{ name: PRINTER_URL_PARAM, value: url }],
    features,
  };
}

/**
 * Build the states batch for one probed printer (same ids as buildPrinterDevice).
 * @param {object} gladys SDK instance
 * @param {{ printer: object, url: string }} probed
 * @returns {Array<{ device_feature_external_id: string, state?: number, text?: string }>}
 */
export function buildPrinterStates(gladys, { printer, url }) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformIdFor(printer, url));
  return [
    { device_feature_external_id: ids.feature(STATE_FEATURE_KEY), text: printer.stateText },
    ...printer.markers
      .filter((marker) => marker.percent !== null)
      .map((marker) => ({
        device_feature_external_id: ids.feature(`marker:${marker.key}`),
        state: marker.percent,
      })),
  ];
}

/**
 * Is this created Gladys device one of our printers? Recognized by the
 * PRINTER_URL param, the only thing polling needs.
 * @param {object} device a device returned by gladys.getDevices()
 * @returns {boolean}
 */
export function isPrinterDevice(device) {
  return (device?.params ?? []).some(
    (param) => param.name === PRINTER_URL_PARAM && typeof param.value === 'string',
  );
}

/**
 * Poll one printer device: query it over IPP and publish the fresh states.
 * When the supplies changed (cartridge swap, renamed supply...), the device
 * is re-published first so the new features exist before their states arrive.
 *
 * Gladys calls this every minute (DEVICE_POLL_FREQUENCY_MS, the slowest value
 * it supports); the ACTUAL IPP query is throttled to config.poll_frequency
 * seconds — ink levels do not need a per-minute refresh. `force` bypasses the
 * throttle, for the integration's own refresh loop and for a fresh device.
 * @param {object} gladys SDK instance
 * @param {object} device the Gladys device (with params) handed to onPoll
 * @param {{ poll_frequency: number }} config
 * @param {{ fetchAttributes?: typeof getPrinterAttributes, now?: () => number, force?: boolean }} [deps] test seam
 */
export async function pollPrinter(gladys, device, config, deps = {}) {
  const { fetchAttributes = getPrinterAttributes, now = Date.now, force = false } = deps;
  const url = (device.params ?? []).find((param) => param.name === PRINTER_URL_PARAM)?.value;
  if (!url) {
    throw new Error(`Device ${device.external_id} has no ${PRINTER_URL_PARAM} param`);
  }

  const last = lastPollAt.get(device.external_id);
  const intervalMs = Math.max(config.poll_frequency, 60) * 1000;
  if (!force && last !== undefined && now() - last < intervalMs) {
    logger.debug(
      `Poll ${device.external_id} skipped (interval ${config.poll_frequency}s not over)`,
    );
    return;
  }

  const attributes = await fetchAttributes(url);
  lastPollAt.set(device.external_id, now());
  const printer = parsePrinter(attributes);
  const probed = { printer, url };

  const rebuilt = buildPrinterDevice(gladys, probed, config);
  const knownFeatureIds = new Set((device.features ?? []).map((f) => f.external_id));
  const hasNewFeature = rebuilt.features.some((f) => !knownFeatureIds.has(f.external_id));
  if (hasNewFeature && knownFeatureIds.size > 0) {
    logger.info(`Supplies changed on ${device.external_id} -> re-publishing the device`);
    await gladys.publishDiscoveredDevices([rebuilt]);
  }

  const states = buildPrinterStates(gladys, probed);
  logger.info(
    `Poll ${device.external_id}: ${printer.stateText}, ` +
      `${printer.markers.map((m) => `${m.name}=${m.percent ?? '?'}%`).join(', ') || 'no marker'}`,
  );
  await gladys.publishStates(states);
}
