// -----------------------------------------------------------------------------
// Dashboard widget contents: pure builders, checked against the core's own
// vocabulary and budget through validateWidgetContent ([] = rendered as sent).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import {
  CRITICAL_LEVEL,
  LOW_LEVEL,
  PRINTER_ACTION,
  buildPrinterContent,
  buildSuppliesContent,
  fit,
  formatReadingTime,
  levelColor,
  localeOf,
  lowestMarker,
  markerFeatureId,
  printerGauges,
  printerSummary,
  stateColor,
  stateLabel,
} from '../src/widgets.js';
import { buildPrinterDevice } from '../src/device.js';
import { parsePrinter } from '../src/printer.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { COLOR_INKJET_ATTRIBUTES } from './helpers/ippFixtures.js';

const URL = 'http://192.168.1.20:631/ipp/print';
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

/** A created Gladys device for the color inkjet fixture, plus its snapshot. */
function inkjet({ lang = 'fr', overrides = {} } = {}) {
  const gladys = createFakeGladys();
  const printer = { ...parsePrinter(COLOR_INKJET_ATTRIBUTES), ...overrides };
  const device = buildPrinterDevice(gladys, { printer, url: URL }, { feature_names: lang });
  const snapshot = {
    state: printer.state,
    stateReasons: printer.stateReasons,
    stateText: printer.stateText,
    markers: printer.markers,
    at: NOW - 5 * 60 * 1000,
  };
  return { device, snapshot, printer };
}

test('the fixture gives a printer with several known levels', () => {
  const { printer } = inkjet();
  assert.ok(printer.markers.filter((m) => m.percent !== null).length >= 2);
});

test('helpers: locale, fit, colors, lowest level', () => {
  assert.equal(localeOf('fr'), 'fr');
  assert.equal(localeOf('fr-FR'), 'fr');
  assert.equal(localeOf('en'), 'en');
  assert.equal(localeOf(undefined), 'en');
  assert.equal(fit('abc', 3), 'abc');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(levelColor(null), WIDGET_COLORS.NEUTRAL);
  assert.equal(levelColor(CRITICAL_LEVEL - 1), WIDGET_COLORS.DANGER);
  assert.equal(levelColor(LOW_LEVEL - 1), WIDGET_COLORS.WARNING);
  assert.equal(levelColor(LOW_LEVEL), WIDGET_COLORS.SUCCESS);
  assert.equal(lowestMarker(undefined), null);
  assert.equal(lowestMarker({ markers: [{ percent: null }] }), null);
  assert.equal(
    lowestMarker({
      markers: [
        { key: 'a', percent: 40 },
        { key: 'b', percent: 5 },
      ],
    }).key,
    'b',
  );
});

test('state label and color follow the printer state', () => {
  const idle = { state: 'idle', stateReasons: [] };
  assert.equal(stateLabel(idle, 'fr'), 'Prête');
  assert.equal(stateLabel(idle, 'en'), 'Idle');
  assert.equal(stateColor(idle), WIDGET_COLORS.SUCCESS);
  const printing = { state: 'printing', stateReasons: [] };
  assert.equal(stateLabel(printing, 'fr'), 'Impression');
  assert.equal(stateColor(printing), WIDGET_COLORS.INFO);
  const stopped = { state: 'stopped', stateReasons: ['media-empty'] };
  assert.equal(stateLabel(stopped, 'fr'), 'Arrêtée (media-empty)');
  assert.equal(stateLabel(stopped, 'en', { withReasons: false }), 'Stopped');
  assert.equal(stateColor(stopped), WIDGET_COLORS.DANGER);
  const warned = { state: 'idle', stateReasons: ['marker-supply-low'] };
  assert.equal(stateColor(warned), WIDGET_COLORS.WARNING);
  assert.equal(stateColor({ state: 'unknown', stateReasons: [] }), WIDGET_COLORS.NEUTRAL);
  assert.equal(stateLabel({ state: 'weird', stateReasons: [] }, 'en'), 'Unknown');
});

test('reading time: the hour today, the day before', () => {
  assert.match(formatReadingTime(NOW - 60_000, 'fr', NOW), /^\d{2}:\d{2}$/);
  assert.match(formatReadingTime(NOW - 3 * 86_400_000, 'en', NOW), /^\d{2}\/\d{2},? \d{2}:\d{2}$/);
});

test('printer widget: heading, live gauges, status rows, check button', () => {
  const { device, snapshot } = inkjet();
  const content = buildPrinterContent({
    device,
    snapshot,
    language: 'fr',
    featureNames: 'fr',
    now: NOW,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 300);

  const [heading] = content.components;
  assert.deepEqual(heading, { type: 'text', variant: 'heading', text: device.name });

  const gauges = content.components.filter((c) => c.type === 'gauge');
  const known = snapshot.markers.filter((m) => m.percent !== null);
  assert.equal(gauges.length, Math.min(known.length, 5));
  for (const gauge of gauges) {
    // Bound to the published level feature: the tile follows the states.
    assert.ok(
      device.features.some((f) => f.external_id === gauge.device_feature),
      `gauge "${gauge.label}" must reference a published feature`,
    );
    assert.equal(gauge.value, undefined);
    assert.ok(gauge.label.length <= 24);
  }
  assert.equal(gauges[0].device_feature, markerFeatureId(device, known[0]));

  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items.length, 3);
  assert.equal(status.items[0].value, 'Prête');
  assert.equal(status.items[0].color, WIDGET_COLORS.SUCCESS);
  assert.match(status.items[1].value, /^\d{2}:\d{2}$/);
  const lowest = lowestMarker(snapshot);
  assert.match(status.items[2].value, new RegExp(` · ${lowest.percent} %$`));

  const button = content.components.find((c) => c.type === 'button');
  assert.equal(button.style, 'secondary');
  assert.deepEqual(button.action, {
    key: PRINTER_ACTION.CHECK,
    params: { printer: device.external_id },
  });
  assert.equal(content.components.length, 1 + gauges.length + 2);
});

test('printer widget: the lowest levels win when a printer has more than 5 supplies', () => {
  const { device, snapshot } = inkjet();
  const markers = Array.from({ length: 9 }, (_, i) => ({
    key: `supply-${i}`,
    name: `Supply ${i}`,
    type: 'ink',
    color: null,
    percent: 90 - i * 10,
    rawLevel: 90 - i * 10,
  }));
  const many = { ...snapshot, markers };
  const gauges = printerGauges(device, many, 'fr');
  // 8 components in all: the heading, the status list and the button leave
  // room for 5 gauges.
  assert.equal(gauges.length, 5);
  assert.deepEqual(
    gauges.map((g) => g.value),
    [10, 20, 30, 40, 50],
  );
  // Not published on the created device: inline gauges, 0-100 %.
  assert.ok(gauges.every((g) => g.min === 0 && g.max === 100 && g.unit === '%'));
  assert.equal(gauges[0].color, WIDGET_COLORS.WARNING);
  const content = buildPrinterContent({
    device,
    snapshot: many,
    language: 'en',
    featureNames: 'en',
  });
  assert.deepEqual(validateWidgetContent(content), []);
});

test('printer widget: unknown levels are skipped, a stopped printer is red', () => {
  const { device, snapshot } = inkjet();
  const stopped = {
    ...snapshot,
    state: 'stopped',
    stateReasons: ['media-empty'],
    stateText: 'stopped (media-empty)',
    markers: snapshot.markers.map((m, i) => (i === 0 ? { ...m, percent: null } : m)),
  };
  const content = buildPrinterContent({
    device,
    snapshot: stopped,
    language: 'en',
    featureNames: 'en',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const gauges = content.components.filter((c) => c.type === 'gauge');
  assert.equal(gauges.length, stopped.markers.filter((m) => m.percent !== null).length);
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items[0].value, 'Stopped (media-empty)');
  assert.equal(status.items[0].color, WIDGET_COLORS.DANGER);
});

test('printer widget before the first reading: the device features, waiting row', () => {
  const { device } = inkjet({ lang: 'en' });
  const content = buildPrinterContent({
    device,
    snapshot: undefined,
    language: 'en',
    featureNames: 'en',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const gauges = content.components.filter((c) => c.type === 'gauge');
  assert.ok(gauges.length > 0);
  assert.ok(gauges.every((g) => g.device_feature.includes(':marker:')));
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((i) => i.value),
    ['Waiting for the first reading'],
  );
  assert.ok(content.components.some((c) => c.type === 'button'));
});

test('printer widget: no level at all, and a printer that reports nothing', () => {
  const { device, snapshot } = inkjet();
  const bare = { ...snapshot, markers: [] };
  const content = buildPrinterContent({
    device,
    snapshot: bare,
    language: 'fr',
    featureNames: 'fr',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components.filter((c) => c.type === 'gauge').length, 0);
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items[2].value, 'Aucun niveau annoncé');
  assert.equal(status.items[2].color, WIDGET_COLORS.NEUTRAL);
});

test('printer widget: empty states are a sentence, never an error', () => {
  const none = buildPrinterContent({ device: null, language: 'fr', featureNames: 'fr' });
  assert.deepEqual(validateWidgetContent(none), []);
  assert.deepEqual(none.components, [
    {
      type: 'text',
      text: {
        en: 'No printer yet: add one from the Discovery tab.',
        fr: "Aucune imprimante : ajoutez-en depuis l'onglet Découverte.",
      },
    },
  ]);
  const missing = buildPrinterContent({
    device: null,
    missing: true,
    language: 'en',
    featureNames: 'en',
  });
  assert.deepEqual(validateWidgetContent(missing), []);
  assert.match(missing.components[0].text.en, /no longer exists/);
});

test('printer widget: a long device name is cut to the heading bound', () => {
  const { device, snapshot } = inkjet();
  const named = { ...device, name: 'A'.repeat(60) };
  const content = buildPrinterContent({
    device: named,
    snapshot,
    language: 'fr',
    featureNames: 'fr',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].text.length, 40);
});

test('printer summary: state · lowest supply, within 40 characters', () => {
  const { snapshot } = inkjet();
  const summary = printerSummary(snapshot, 'fr', 'fr');
  const lowest = lowestMarker(snapshot);
  assert.match(summary.text, new RegExp(`^Prête · .+ ${lowest.percent} %$`));
  assert.equal(summary.percent, lowest.percent);
  assert.equal(summary.read, true);
  const long = {
    ...snapshot,
    markers: [{ key: 'x', name: 'X'.repeat(50), type: null, color: null, percent: 7 }],
  };
  const cut = printerSummary(long, 'en', 'printer');
  assert.ok(cut.text.length <= 40, cut.text);
  assert.match(cut.text, /^Idle · X+… 7 %$/);
  assert.equal(cut.color, WIDGET_COLORS.DANGER);
  assert.equal(printerSummary(undefined, 'fr', 'fr').text, 'En attente du premier relevé');
  assert.equal(printerSummary(undefined, 'fr', 'fr').read, false);
  const noLevel = printerSummary({ ...snapshot, markers: [] }, 'fr', 'fr');
  assert.equal(noLevel.text, 'Prête');
  assert.equal(noLevel.color, WIDGET_COLORS.NEUTRAL);
  const stoppedFull = printerSummary(
    { ...snapshot, state: 'stopped', markers: [{ key: 'k', name: 'black', percent: 80 }] },
    'en',
    'en',
  );
  assert.equal(stoppedFull.color, WIDGET_COLORS.DANGER);
});

test('supplies widget: count to watch, rows most critical first, valid content', () => {
  const base = inkjet();
  const printerAt = (name, percent, extra = {}) => ({
    device: { ...base.device, external_id: `printer:${name}`, name },
    snapshot: {
      ...base.snapshot,
      markers: [{ key: 'k', name: 'black ink', type: 'ink', color: null, percent }],
      ...extra,
    },
  });
  const content = buildSuppliesContent({
    printers: [
      printerAt('Office', 60),
      { device: { ...base.device, external_id: 'printer:new', name: 'New' }, snapshot: undefined },
      printerAt('Kitchen', 8),
      printerAt('NoLevel', null),
      printerAt('Attic', 20, { state: 'stopped', stateReasons: ['media-empty'] }),
    ],
    language: 'fr',
    featureNames: 'fr',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 300);
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 2);
  assert.equal(tile.color, WIDGET_COLORS.WARNING);
  assert.deepEqual(tile.label, { en: 'To watch', fr: 'À surveiller' });
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((i) => i.label),
    ['Kitchen', 'Attic', 'Office', 'NoLevel', 'New'],
  );
  assert.equal(status.items[0].value, 'Prête · Noir 8 %');
  assert.equal(status.items[0].color, WIDGET_COLORS.DANGER);
  assert.equal(status.items[1].value, 'Arrêtée · Noir 20 %');
  assert.equal(status.items[1].color, WIDGET_COLORS.WARNING);
  assert.equal(status.items[2].color, WIDGET_COLORS.SUCCESS);
  assert.equal(status.items[3].value, 'Prête');
  assert.equal(status.items[3].color, WIDGET_COLORS.NEUTRAL);
  assert.equal(status.items[4].value, 'En attente du premier relevé');
});

test('supplies widget: all good is green, and the list stops at 10 rows', () => {
  const base = inkjet();
  const printers = Array.from({ length: 12 }, (_, i) => ({
    device: { ...base.device, external_id: `printer:${i}`, name: `Printer ${i}` },
    snapshot: {
      ...base.snapshot,
      markers: [{ key: 'k', name: 'black', type: 'toner', color: null, percent: 30 + i }],
    },
  }));
  const content = buildSuppliesContent({ printers, language: 'en', featureNames: 'en' });
  assert.deepEqual(validateWidgetContent(content), []);
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 0);
  assert.equal(tile.color, WIDGET_COLORS.SUCCESS);
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items.length, 10);
  assert.equal(status.items[0].label, 'Printer 0');
  assert.equal(status.items[0].value, 'Idle · Black 30 %');
});

test('supplies widget: no printer is a sentence', () => {
  const content = buildSuppliesContent({ printers: [], language: 'en', featureNames: 'en' });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components.length, 1);
  assert.equal(content.components[0].type, 'text');
});

test('no widget content ever uses the primary style (invisible in dark mode)', () => {
  const { device, snapshot } = inkjet();
  const contents = [
    buildPrinterContent({ device, snapshot, language: 'fr', featureNames: 'fr' }),
    buildPrinterContent({ device, language: 'fr', featureNames: 'fr' }),
    buildSuppliesContent({ printers: [{ device, snapshot }], language: 'fr', featureNames: 'fr' }),
  ];
  for (const content of contents) {
    for (const component of content.components) {
      assert.notEqual(component.style, 'primary');
      assert.notEqual(component.color, 'primary');
    }
  }
});
