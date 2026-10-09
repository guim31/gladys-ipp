// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+), content builders — pure functions.
//
//   - printer  : ONE printer: a live gauge per supply (bound to the level
//                features, so it follows the published states), the state
//                and the time of the last reading, the lowest level, and a
//                "Check" button that queries the printer now;
//   - supplies : EVERY created printer in one list, the most critical
//                first, with the number of printers to watch.
//
// Both read the last answer kept in memory by the sampling loop (see
// rememberPrinterSnapshot in device.js): rendering a widget never sends an
// IPP or SNMP request. index.js resolves the devices and the snapshots and
// hands them over here.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { markerPart, shortMarkerNames } from './naming.js';

/** Widget keys, declared in the manifest `widgets` (forever: never rename). */
export const WIDGET = {
  PRINTER: 'printer',
  SUPPLIES: 'supplies',
};

/** Action keys of the `printer` widget buttons (relayed to onWidgetAction). */
export const PRINTER_ACTION = {
  CHECK: 'check',
};

/** Below this level (%) a supply is critical (red). */
export const CRITICAL_LEVEL = 10;
/** Below this level (%) a supply is to watch (orange). */
export const LOW_LEVEL = 25;

// The core keeps at most 8 components per widget (and 10 status rows): the
// heading, the status list and the button leave room for 5 gauges. The
// supplies beyond them go to the status list, after its 3 rows.
const MAX_GAUGES = 5;
const MAX_ROWS = 10;
const TTL_SECONDS = 300;

const TEXTS = {
  state: { en: 'State', fr: 'État' },
  lastReading: { en: 'Last reading', fr: 'Dernier relevé' },
  lowest: { en: 'Lowest level', fr: 'Niveau le plus bas' },
  toWatch: { en: 'To watch', fr: 'À surveiller' },
  check: { en: 'Check', fr: 'Vérifier' },
  noPrinter: {
    en: 'No printer yet: add one from the Discovery tab.',
    fr: "Aucune imprimante : ajoutez-en depuis l'onglet Découverte.",
  },
  missingPrinter: {
    en: 'This printer no longer exists: pick another one in the widget settings.',
    fr: "Cette imprimante n'existe plus : choisissez-en une autre dans les réglages du widget.",
  },
  waiting: { en: 'Waiting for the first reading', fr: 'En attente du premier relevé' },
  noLevel: { en: 'No level reported', fr: 'Aucun niveau annoncé' },
  states: {
    idle: { en: 'Idle', fr: 'Prête' },
    printing: { en: 'Printing', fr: 'Impression' },
    stopped: { en: 'Stopped', fr: 'Arrêtée' },
    unknown: { en: 'Unknown', fr: 'Inconnu' },
  },
  // The most common printer-state-reasons (severity suffix already removed
  // by cleanStateReasons); any other one is shown as reported.
  reasons: {
    'toner-low': { en: 'toner low', fr: 'toner bas' },
    'toner-empty': { en: 'toner empty', fr: 'toner vide' },
    'marker-supply-low': { en: 'supply low', fr: 'consommable bas' },
    'marker-supply-empty': { en: 'supply empty', fr: 'consommable vide' },
    'marker-waste-almost-full': { en: 'waste almost full', fr: 'récupérateur presque plein' },
    'marker-waste-full': { en: 'waste full', fr: 'récupérateur plein' },
    'media-empty': { en: 'out of paper', fr: 'plus de papier' },
    'media-low': { en: 'paper low', fr: 'papier bas' },
    'media-jam': { en: 'paper jam', fr: 'bourrage papier' },
    'media-needed': { en: 'paper needed', fr: 'papier requis' },
    'door-open': { en: 'door open', fr: 'porte ouverte' },
    'cover-open': { en: 'cover open', fr: 'capot ouvert' },
    'input-tray-missing': { en: 'tray missing', fr: 'bac absent' },
    'output-area-full': { en: 'output tray full', fr: 'bac de sortie plein' },
    offline: { en: 'offline', fr: 'hors ligne' },
    paused: { en: 'paused', fr: 'en pause' },
  },
};

/**
 * The language a widget is rendered in: French, or English for everything
 * else (the texts above only exist in these two).
 * @param {string} language ISO 639-1 code sent by the core
 * @returns {'fr'|'en'}
 */
export function localeOf(language) {
  return String(language ?? '')
    .toLowerCase()
    .startsWith('fr')
    ? 'fr'
    : 'en';
}

/**
 * Cut a text to a widget bound, with an ellipsis.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function fit(text, max) {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Localized state of a printer, with its reasons when `withReasons`:
 * "Arrêtée (plus de papier)". Unknown reasons are kept as reported.
 * @param {{ state: string, stateReasons: string[] }} snapshot
 * @param {string} language
 * @param {{ withReasons?: boolean }} [options]
 * @returns {string}
 */
export function stateLabel(snapshot, language, { withReasons = true } = {}) {
  const lang = localeOf(language);
  const word = (TEXTS.states[snapshot.state] ?? TEXTS.states.unknown)[lang];
  const reasons = (withReasons ? (snapshot.stateReasons ?? []) : []).map(
    (reason) => TEXTS.reasons[reason]?.[lang] ?? reason,
  );
  return reasons.length > 0 ? `${word} (${reasons.join(', ')})` : word;
}

/**
 * Color of a printer state: green when idle, blue while printing, red when
 * stopped, orange when idle with a reason (the printer reports a warning:
 * "marker-supply-low"...), gray when unknown.
 * @param {{ state: string, stateReasons: string[] }} snapshot
 * @returns {string}
 */
export function stateColor(snapshot) {
  if (snapshot.state === 'stopped') {
    return WIDGET_COLORS.DANGER;
  }
  if (snapshot.state === 'printing') {
    return WIDGET_COLORS.INFO;
  }
  if (snapshot.state === 'idle') {
    return (snapshot.stateReasons ?? []).length > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS;
  }
  return WIDGET_COLORS.NEUTRAL;
}

/**
 * Color of a supply level.
 * @param {number|null} percent
 * @returns {string}
 */
export function levelColor(percent) {
  if (percent === null || percent === undefined) {
    return WIDGET_COLORS.NEUTRAL;
  }
  if (percent < CRITICAL_LEVEL) {
    return WIDGET_COLORS.DANGER;
  }
  if (percent < LOW_LEVEL) {
    return WIDGET_COLORS.WARNING;
  }
  return WIDGET_COLORS.SUCCESS;
}

/**
 * The supplies whose level is known, lowest first.
 * @param {Array<{ percent: number|null }>} markers
 * @returns {Array<object>}
 */
export function knownLevels(markers) {
  return (markers ?? [])
    .filter((marker) => typeof marker.percent === 'number')
    .sort((a, b) => a.percent - b.percent);
}

/**
 * The lowest supply of a printer, or null when it reports no level.
 * @param {{ markers: Array<object> }|undefined} snapshot
 * @returns {object|null}
 */
export function lowestMarker(snapshot) {
  return knownLevels(snapshot?.markers)[0] ?? null;
}

/**
 * The supplies of a printer whose level is known, in the printer order,
 * each with its widget `label` (shortMarkerName, distinct within the
 * printer: two rollers never share a label).
 * @param {{ markers: Array<object> }|undefined} snapshot
 * @param {string} featureNames language of the feature names (config)
 * @returns {Array<object>} the markers, plus `label`
 */
export function labelledLevels(snapshot, featureNames) {
  const markers = snapshot?.markers ?? [];
  const labels = shortMarkerNames(markers, featureNames);
  return markers
    .map((marker, index) => ({ ...marker, label: labels[index] }))
    .filter((marker) => typeof marker.percent === 'number');
}

/**
 * Whether a supply is a cartridge (ink, toner) rather than a printer part
 * or a waste container: those come first on the printer widget.
 * @param {{ name?: string, type?: string|null }} marker
 * @returns {boolean}
 */
function isCartridge(marker) {
  return markerPart(marker) === null;
}

/**
 * Share the known levels of a printer between the gauges and the status
 * rows. All fit: every one gets a gauge, in the printer order. Beyond the
 * tile budget, no cartridge is pushed out by a part: the cartridges first,
 * in the printer order (the lowest ones when there are more than the
 * budget), then the parts, the lowest first. The others become status rows,
 * the lowest first.
 * @param {Array<object>} known supplies with a known level, printer order
 * @returns {{ gauges: Array<object>, rows: Array<object> }}
 */
export function splitLevels(known) {
  if (known.length <= MAX_GAUGES) {
    return { gauges: known, rows: [] };
  }
  let cartridges = known.filter(isCartridge);
  if (cartridges.length > MAX_GAUGES) {
    const lowest = new Set(knownLevels(cartridges).slice(0, MAX_GAUGES));
    cartridges = cartridges.filter((marker) => lowest.has(marker));
  }
  const parts = knownLevels(known.filter((marker) => !isCartridge(marker)));
  const gauges = [...cartridges, ...parts.slice(0, MAX_GAUGES - cartridges.length)];
  const shown = new Set(gauges);
  return { gauges, rows: knownLevels(known.filter((marker) => !shown.has(marker))) };
}

/**
 * Time of a reading, short: "14:05" today, "04/10 14:05" before.
 * @param {number} at epoch ms of the reading
 * @param {string} language
 * @param {number} [now] epoch ms (tests)
 * @returns {string}
 */
export function formatReadingTime(at, language, now = Date.now()) {
  const locale = localeOf(language) === 'fr' ? 'fr-FR' : 'en-GB';
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const options = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * One line summing up a printer (≤ 40): "Prête · Noir 12 %", "Arrêtée",
 * "En attente du premier relevé".
 * @param {object|undefined} snapshot
 * @param {string} language
 * @param {string} featureNames language of the feature names (config)
 * @returns {{ text: string, color: string, percent: number|null, read: boolean }}
 *   `percent` is the lowest level (null when unknown), `read` tells whether
 *   the printer answered at least once
 */
export function printerSummary(snapshot, language, featureNames) {
  const lang = localeOf(language);
  if (!snapshot) {
    return { text: TEXTS.waiting[lang], color: WIDGET_COLORS.NEUTRAL, percent: null, read: false };
  }
  const state = stateLabel(snapshot, lang, { withReasons: false });
  const lowest = knownLevels(labelledLevels(snapshot, featureNames))[0];
  if (!lowest) {
    return {
      text: fit(state, 40),
      color: snapshot.state === 'stopped' ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
      percent: null,
      read: true,
    };
  }
  // The state word and the level are the parts worth keeping whole: the
  // supply name gives way when the three do not fit in 40 characters.
  const tail = ` ${lowest.percent} %`;
  const room = 40 - state.length - ' · '.length - tail.length;
  const name = fit(lowest.label, Math.max(room, 4));
  return {
    text: `${state} · ${name}${tail}`,
    color:
      snapshot.state === 'stopped' && lowest.percent >= LOW_LEVEL
        ? WIDGET_COLORS.DANGER
        : levelColor(lowest.percent),
    percent: lowest.percent,
    read: true,
  };
}

/**
 * External id of a supply feature, as published by buildPrinterDevice (the
 * SDK derives feature ids from the device id: `<device>:<key>`).
 * @param {{ external_id: string }} device
 * @param {{ key: string }} marker
 * @returns {string}
 */
export function markerFeatureId(device, marker) {
  return `${device.external_id}:marker:${marker.key}`;
}

/**
 * The gauge of one supply, bound to the level feature when the created
 * device has it (live), inline otherwise (a cartridge that appeared since
 * the device was added).
 * @param {{ external_id: string }} device
 * @param {Set<string>} features external ids of the device features
 * @param {object} marker a supply of labelledLevels
 * @returns {object} gauge component
 */
function supplyGauge(device, features, marker) {
  const gauge = { type: 'gauge', label: fit(marker.label, 24), color: levelColor(marker.percent) };
  const featureId = markerFeatureId(device, marker);
  if (features.has(featureId)) {
    return { ...gauge, device_feature: featureId };
  }
  return { ...gauge, value: marker.percent, min: 0, max: 100, unit: '%' };
}

/**
 * The gauges of a printer (see splitLevels for which supplies get one).
 * Before the first reading, the level features of the device, cartridges
 * first (recognized by their name), with their frozen names.
 * @param {{ external_id: string, features?: Array<{ external_id: string, name: string }> }} device
 * @param {object|undefined} snapshot
 * @param {string} featureNames language of the feature names (config)
 * @returns {Array<object>} gauge components, at most MAX_GAUGES
 */
export function printerGauges(device, snapshot, featureNames) {
  if (!snapshot) {
    const prefix = `${device.external_id}:marker:`;
    const levels = (device.features ?? []).filter((feature) =>
      feature.external_id.startsWith(prefix),
    );
    const byName = (feature) => isCartridge({ name: feature.name, type: null });
    return [...levels.filter(byName), ...levels.filter((feature) => !byName(feature))]
      .slice(0, MAX_GAUGES)
      .map((feature) => ({
        type: 'gauge',
        label: fit(feature.name, 24),
        device_feature: feature.external_id,
      }));
  }
  const features = new Set((device.features ?? []).map((feature) => feature.external_id));
  return splitLevels(labelledLevels(snapshot, featureNames)).gauges.map((marker) =>
    supplyGauge(device, features, marker),
  );
}

/**
 * A widget with nothing to show but a sentence.
 * @param {{ en: string, fr: string }} text
 * @returns {object} the content
 */
function messageContent(text) {
  return { version: 1, ttl_seconds: TTL_SECONDS, components: [{ type: 'text', text }] };
}

/**
 * Content of the `printer` widget.
 * @param {{ device: object|null, snapshot?: object, language: string,
 *   featureNames: string, missing?: boolean, now?: number }} input
 *   `device` is the created Gladys device (name, external_id, features),
 *   `snapshot` its last answer (undefined before the first one), `missing`
 *   is set when the printer picked in the settings no longer exists.
 * @returns {object} the content
 */
export function buildPrinterContent({
  device,
  snapshot,
  language,
  featureNames,
  missing = false,
  now = Date.now(),
}) {
  if (!device) {
    return messageContent(missing ? TEXTS.missingPrinter : TEXTS.noPrinter);
  }
  const lang = localeOf(language);
  const components = [
    { type: 'text', variant: 'heading', text: fit(device.name, 40) },
    ...printerGauges(device, snapshot, featureNames),
  ];
  const known = labelledLevels(snapshot, featureNames);
  const rows = [];
  if (!snapshot) {
    rows.push({ label: TEXTS.state, value: TEXTS.waiting[lang], color: WIDGET_COLORS.NEUTRAL });
  } else {
    rows.push({
      label: TEXTS.state,
      value: fit(stateLabel(snapshot, lang), 40),
      color: stateColor(snapshot),
    });
    rows.push({ label: TEXTS.lastReading, value: formatReadingTime(snapshot.at, lang, now) });
    const lowest = knownLevels(known)[0];
    rows.push(
      lowest
        ? {
            label: TEXTS.lowest,
            value: fit(`${lowest.label} · ${lowest.percent} %`, 40),
            color: levelColor(lowest.percent),
          }
        : { label: TEXTS.lowest, value: TEXTS.noLevel[lang], color: WIDGET_COLORS.NEUTRAL },
    );
    // The supplies left without a gauge are listed, so none goes missing.
    for (const marker of splitLevels(known).rows) {
      rows.push({
        label: fit(marker.label, 40),
        value: `${marker.percent} %`,
        color: levelColor(marker.percent),
      });
    }
  }
  components.push({ type: 'status', items: rows.slice(0, MAX_ROWS) });
  components.push({
    type: 'button',
    label: TEXTS.check,
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: PRINTER_ACTION.CHECK, params: { printer: device.external_id } },
  });
  return { version: 1, ttl_seconds: TTL_SECONDS, components };
}

/**
 * Content of the `supplies` widget.
 * @param {{ printers: Array<{ device: object, snapshot?: object }>, language: string,
 *   featureNames: string }} input every created printer with its last answer
 * @returns {object} the content
 */
export function buildSuppliesContent({ printers, language, featureNames }) {
  if (printers.length === 0) {
    return messageContent(TEXTS.noPrinter);
  }
  const rows = printers
    .map(({ device, snapshot }) => ({
      name: fit(device.name, 40),
      ...printerSummary(snapshot, language, featureNames),
    }))
    // The most critical first: known levels ascending, then the printers
    // without a known level, the ones never read last.
    .sort((a, b) => rank(a) - rank(b) || (a.percent ?? 0) - (b.percent ?? 0));
  const toWatch = rows.filter((row) => row.percent !== null && row.percent < LOW_LEVEL).length;
  return {
    version: 1,
    ttl_seconds: TTL_SECONDS,
    components: [
      {
        type: 'value',
        label: TEXTS.toWatch,
        value: toWatch,
        icon: toWatch > 0 ? 'alert-triangle' : 'check-circle',
        color: toWatch > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
      },
      {
        type: 'status',
        items: rows
          .slice(0, MAX_ROWS)
          .map((row) => ({ label: row.name, value: row.text, color: row.color })),
      },
    ],
  };
}

function rank(row) {
  if (row.percent !== null) {
    return 0;
  }
  return row.read ? 1 : 2;
}
