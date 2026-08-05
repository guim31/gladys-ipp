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
// [60000, 30000, 15000, 10000, 2000, 1000]. One minute is the slowest, and it
// is what we want: the printer is queried every minute so the STATE stays
// current, while the supply LEVELS are only published every
// config.poll_frequency seconds (see pollPrinter).
export const DEVICE_POLL_FREQUENCY_MS = 60_000;

// Timestamp of the last LEVELS publish, per device external_id. Only the
// levels are throttled: they keep history, so publishing them every minute
// would bloat it for values that move over weeks. The state is volatile
// ('printing' lasts seconds) and keeps no history: it is published on every
// poll, otherwise a print job is simply never observed.
const lastLevelsAt = new Map();

/** Reset the levels throttle (tests only). */
export function resetPollThrottle() {
  lastLevelsAt.clear();
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
      // min/max are NOT NULL in the Gladys schema, with no default: EVERY
      // feature must carry them, even a text one where they mean nothing.
      // Omitting them fails device creation with a 422.
      min: 0,
      max: 1,
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
 * @param {{ withLevels?: boolean }} [options] omit the supply levels (state-only refresh)
 * @returns {Array<{ device_feature_external_id: string, state?: number, text?: string }>}
 */
export function buildPrinterStates(gladys, { printer, url }, { withLevels = true } = {}) {
  const ids = gladys.externalIds(DEVICE_TYPE, platformIdFor(printer, url));
  const states = [
    { device_feature_external_id: ids.feature(STATE_FEATURE_KEY), text: printer.stateText },
  ];
  if (!withLevels) {
    return states;
  }
  return [
    ...states,
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
 * it supports). The STATE is refreshed on EVERY call: 'printing' lasts a few
 * seconds, so sampling it at the (much slower) levels interval reports a
 * permanent 'idle'. The LEVELS are published at config.poll_frequency only —
 * they keep history and move over weeks. `force` publishes both, for the
 * integration's own refresh loop and for a freshly created device.
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

  const attributes = await fetchAttributes(url);
  const printer = parsePrinter(attributes);
  const probed = { printer, url };

  const lastLevels = lastLevelsAt.get(device.external_id);
  const levelsIntervalMs = Math.max(config.poll_frequency, 60) * 1000;
  const withLevels = force || lastLevels === undefined || now() - lastLevels >= levelsIntervalMs;

  if (withLevels) {
    const rebuilt = buildPrinterDevice(gladys, probed, config);
    const knownFeatureIds = new Set((device.features ?? []).map((f) => f.external_id));
    const hasNewFeature = rebuilt.features.some((f) => !knownFeatureIds.has(f.external_id));
    if (hasNewFeature && knownFeatureIds.size > 0) {
      logger.info(`Supplies changed on ${device.external_id} -> re-publishing the device`);
      await gladys.publishDiscoveredDevices([rebuilt]);
    }
  }

  const states = buildPrinterStates(gladys, probed, { withLevels });
  if (withLevels) {
    lastLevelsAt.set(device.external_id, now());
    logger.info(
      `Poll ${device.external_id}: ${printer.stateText}, ` +
        `${printer.markers.map((m) => `${m.name}=${m.percent ?? '?'}%`).join(', ') || 'no marker'}`,
    );
  } else {
    logger.debug(`Poll ${device.external_id}: state "${printer.stateText}" (levels not due)`);
  }
  await gladys.publishStates(states);
}
