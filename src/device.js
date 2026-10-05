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
import { displayMarkerName, displayStateName } from './naming.js';
import { parsePrinter, slugify } from './printer.js';
import { withFallbackSupplies } from './supplies.js';

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
// levels are throttled: they keep history, so publishing them on every sample
// would bloat it for values that move over weeks. The state is volatile
// ('printing' lasts seconds) and keeps no history: it is sampled often and
// published as soon as it CHANGES (see lastStateText below).
const lastLevelsAt = new Map();

// Last state text published, per device external_id: publish-on-change, so
// the frequent state sampling does not spam Gladys with identical 'idle'.
const lastStateText = new Map();

// Last answer of each printer, per device external_id: what the dashboard
// widgets show (state, levels, time of the reading). Fed by every successful
// sample, published or not, so a widget never queries a printer itself. The
// markers only move on a LEVELS sample: a state-only sample keeps the ones
// of the last levels reading (an SNMP-only printer announces none over IPP).
const printerSnapshots = new Map();

// Poll in flight, per device external_id: the widget "Check" button and the
// sampling loop may ask for the same printer at the same time, and two
// concurrent IPP requests (then two publishes) are never worth it — the
// second caller shares the promise of the first.
const pollsInFlight = new Map();

/** Reset the poll bookkeeping (tests only). */
export function resetPollThrottle() {
  lastLevelsAt.clear();
  lastStateText.clear();
  printerSnapshots.clear();
  pollsInFlight.clear();
}

/**
 * Last known answer of a created printer, or undefined before its first
 * successful sample.
 * @param {string} deviceExternalId
 * @returns {{ state: string, stateReasons: string[], stateText: string,
 *             markers: Array<object>, at: number }|undefined}
 */
export function getPrinterSnapshot(deviceExternalId) {
  return printerSnapshots.get(deviceExternalId);
}

/**
 * Remember the answer of a printer for the widgets.
 * @param {string} deviceExternalId
 * @param {{ state: string, stateReasons: string[], stateText: string, markers: Array<object> }} printer
 * @param {{ withLevels: boolean, at: number }} options `withLevels` tells
 *   whether the markers of this answer are complete (SNMP fallback included)
 */
export function rememberPrinterSnapshot(deviceExternalId, printer, { withLevels, at }) {
  const previous = printerSnapshots.get(deviceExternalId);
  printerSnapshots.set(deviceExternalId, {
    state: printer.state,
    stateReasons: printer.stateReasons,
    stateText: printer.stateText,
    markers: withLevels || !previous ? printer.markers : previous.markers,
    at,
  });
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
 * Feature names follow config.feature_names ('printer' raw / 'fr' / 'en');
 * feature KEYS always derive from the raw printer names, so switching the
 * language never changes the external_ids nor loses history.
 * @param {object} gladys SDK instance
 * @param {{ printer: object, url: string }} probed
 * @param {{ feature_names?: string }} config
 */
export function buildPrinterDevice(gladys, { printer, url }, config = {}) {
  const lang = config.feature_names ?? 'printer';
  const ids = gladys.externalIds(DEVICE_TYPE, platformIdFor(printer, url));
  const features = [
    {
      name: displayStateName(lang),
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
        name: displayMarkerName(marker, lang),
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
 * Called both by the Gladys scheduler and by the integration's own sampling
 * loop (every STATE_SAMPLING_MS, see index.js): a print job lasts seconds,
 * so the state must be sampled far more often than it is worth storing.
 * Publication is decoupled from sampling:
 *   - the STATE is published when it CHANGES (it keeps no history, and
 *     re-publishing an identical 'idle' every 15 s is pure noise);
 *   - the LEVELS are published at config.poll_frequency — they keep history
 *     and move over weeks.
 * `force` publishes everything now (fresh device, reconnection).
 * @param {object} gladys SDK instance
 * @param {object} device the Gladys device (with params) handed to onPoll
 * @param {{ poll_frequency: number }} config
 * @param {{ fetchAttributes?: typeof getPrinterAttributes, now?: () => number,
 *           force?: boolean, fallbackSupplies?: typeof withFallbackSupplies }} [deps] test seam
 * @returns {Promise<{ published: boolean, stateChanged: boolean, withLevels: boolean }>}
 *   what this sample did, so the caller can nudge the dashboard widgets
 */
export function pollPrinter(gladys, device, config, deps = {}) {
  const inFlight = pollsInFlight.get(device.external_id);
  if (inFlight) {
    return inFlight;
  }
  const poll = samplePrinter(gladys, device, config, deps).finally(() => {
    pollsInFlight.delete(device.external_id);
  });
  pollsInFlight.set(device.external_id, poll);
  return poll;
}

/** The poll itself, see pollPrinter. */
async function samplePrinter(gladys, device, config, deps) {
  const {
    fetchAttributes = getPrinterAttributes,
    now = Date.now,
    force = false,
    fallbackSupplies = withFallbackSupplies,
  } = deps;
  const url = (device.params ?? []).find((param) => param.name === PRINTER_URL_PARAM)?.value;
  if (!url) {
    throw new Error(`Device ${device.external_id} has no ${PRINTER_URL_PARAM} param`);
  }

  const attributes = await fetchAttributes(url);
  let printer = parsePrinter(attributes);

  const lastLevels = lastLevelsAt.get(device.external_id);
  const levelsIntervalMs = Math.max(config.poll_frequency, 60) * 1000;
  const withLevels = force || lastLevels === undefined || now() - lastLevels >= levelsIntervalMs;
  const stateChanged = lastStateText.get(device.external_id) !== printer.stateText;

  if (!withLevels && !stateChanged) {
    logger.debug(
      `Poll ${device.external_id}: "${printer.stateText}" unchanged, nothing to publish`,
    );
    // The printer did answer: the widgets' "last reading" moves anyway.
    rememberPrinterSnapshot(device.external_id, printer, { withLevels: false, at: now() });
    return { published: false, stateChanged: false, withLevels: false };
  }

  if (withLevels) {
    // Only worth asking when the levels are actually due: the state samples
    // every 15 s and must stay a single IPP request.
    printer = await fallbackSupplies(printer, url);
  }
  const probed = { printer, url };
  rememberPrinterSnapshot(device.external_id, printer, { withLevels, at: now() });

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
        `${
          printer.markers
            .map((m) => `${m.name}=${m.percent !== null ? `${m.percent}%` : `raw:${m.rawLevel}`}`)
            .join(', ') || 'no marker'
        }`,
    );
  } else {
    logger.info(`Poll ${device.external_id}: state -> "${printer.stateText}"`);
  }
  await gladys.publishStates(states);
  lastStateText.set(device.external_id, printer.stateText);
  return { published: true, stateChanged, withLevels };
}
