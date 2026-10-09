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
  assert.equal(stateLabel(stopped, 'fr'), 'Arrêtée (plus de papier)');
  assert.equal(stateLabel(stopped, 'en'), 'Stopped (out of paper)');
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

test('printer widget: more than 5 cartridges, the 5 lowest in the printer order', () => {
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
    [50, 40, 30, 20, 10],
  );
  // Not published on the created device: inline gauges, 0-100 %.
  assert.ok(gauges.every((g) => g.min === 0 && g.max === 100 && g.unit === '%'));
  assert.equal(gauges[4].color, WIDGET_COLORS.WARNING);
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
  assert.equal(status.items[0].value, 'Stopped (out of paper)');
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

// --- No cartridge pushed out by a part (forum feedback, 1.2.0) ----------------

/** A supply as parsePrinter / the SNMP complement give it. */
const supply = (key, name, type, percent, source) => ({
  key,
  name,
  type,
  color: null,
  percent,
  rawLevel: percent,
  ...(source ? { source } : {}),
});

/** A created device for these supplies, plus its snapshot. */
function printerWith(markers, { lang = 'fr', reasons = [] } = {}) {
  const gladys = createFakeGladys();
  const printer = { ...parsePrinter(COLOR_INKJET_ATTRIBUTES), markers, stateReasons: reasons };
  const device = buildPrinterDevice(gladys, { printer, url: URL }, { feature_names: lang });
  const snapshot = {
    state: 'idle',
    stateReasons: reasons,
    stateText: 'idle',
    markers,
    at: NOW - 60_000,
  };
  return { device, snapshot };
}

// HP Color Laser MFP 178nw: 4 IPP toners, 3 SNMP parts.
const HP_178NW = [
  supply('black-toner', 'Black Toner', 'toner', 40),
  supply('cyan-toner', 'Cyan Toner', 'toner', 10),
  supply('magenta-toner', 'Magenta Toner', 'toner', 80),
  supply('yellow-toner', 'Yellow Toner', 'toner', 70),
  supply('transfer-belt', 'Transfer Belt', 'transfer-unit', 92, 'snmp'),
  supply('fuser-unit', 'Fuser Unit', 'fuser', 92, 'snmp'),
  supply('pickup-roller', 'Pickup Roller', 'other', 97, 'snmp'),
];

test('printer widget: a color laser keeps its 4 toners, the parts go to the list', () => {
  const { device, snapshot } = printerWith(HP_178NW);
  const content = buildPrinterContent({
    device,
    snapshot,
    language: 'fr',
    featureNames: 'fr',
    now: NOW,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const gauges = content.components.filter((c) => c.type === 'gauge');
  // The 4 toners in the printer order, then the lowest part.
  assert.deepEqual(
    gauges.map((g) => g.label),
    ['Noir', 'Cyan', 'Magenta', 'Jaune', 'Transfert'],
  );
  // All on the created device: live gauges.
  assert.ok(gauges.every((g) => g.device_feature?.includes(':marker:')));
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((i) => [i.label.fr ?? i.label, i.value]),
    [
      ['État', 'Prête'],
      ['Dernier relevé', status.items[1].value],
      ['Niveau le plus bas', 'Cyan · 10 %'],
      ['Four', '92 %'],
      ['Rouleau prise', '97 %'],
    ],
  );
  assert.equal(status.items[3].color, WIDGET_COLORS.SUCCESS);
});

test('printer widget: up to 5 known levels, the printer order is kept', () => {
  const { device, snapshot } = printerWith([
    supply('drum', 'Drum Unit', 'opc', 15),
    supply('black-toner', 'Black Toner', 'toner', 60),
  ]);
  const gauges = printerGauges(device, snapshot, 'fr');
  assert.deepEqual(
    gauges.map((g) => g.label),
    ['Tambour', 'Noir'],
  );
  const content = buildPrinterContent({ device, snapshot, language: 'fr', featureNames: 'fr' });
  assert.equal(content.components.find((c) => c.type === 'status').items.length, 3);
});

test('printer widget: the Samsung rollers get distinct gauges and feature names', () => {
  const markers = [
    supply('black-toner', 'Black Toner', 'toner', 60),
    supply('imaging-unit', 'Imaging Unit', 'opc', 10, 'snmp'),
    supply('transfer-roller', 'Transfer Roller', 'transfer-unit', 80, 'snmp'),
    supply('tray1-pickup-roller', 'Tray1 Pickup Roller', 'other', 85, 'snmp'),
    supply('mp-pickup-roller', 'MP Pickup Roller', 'other', 85, 'snmp'),
  ];
  const { device, snapshot } = printerWith(markers);
  const gauges = printerGauges(device, snapshot, 'fr');
  assert.deepEqual(
    gauges.map((g) => g.label),
    ['Noir', 'Tambour', 'Transfert', 'Rouleau prise bac 1', 'Rouleau prise bac MF'],
  );
  assert.deepEqual(
    device.features.filter((f) => f.external_id.includes(':marker:')).map((f) => f.name),
    [
      'Toner noir',
      "Unité d'imagerie",
      'Unité de transfert',
      'Rouleau de prise papier (bac 1)',
      'Rouleau de prise papier (bac multifonction)',
    ],
  );

  // Unknown raw names that both read "Roller": numbered on the tiles too.
  const same = printerWith([
    supply('black-toner', 'Black Toner', 'toner', 60),
    supply('roller', 'Roller', 'other', 85, 'snmp'),
    supply('roller-2', 'Roller', 'other', 85, 'snmp'),
  ]);
  assert.deepEqual(
    printerGauges(same.device, same.snapshot, 'fr').map((g) => g.label),
    ['Noir', 'Rouleau 1', 'Rouleau 2'],
  );
});

test('printer widget: more than 5 cartridges leave no gauge to the parts', () => {
  const inks = ['Black', 'Photo Black', 'Cyan', 'Magenta', 'Yellow', 'Gray'].map((name, i) =>
    supply(name.toLowerCase(), `${name} Ink`, 'ink-cartridge', 30 + i * 10),
  );
  const markers = [...inks, supply('waste', 'Maintenance Box', 'waste-ink', 5, 'snmp')];
  const { device, snapshot } = printerWith(markers);
  const content = buildPrinterContent({ device, snapshot, language: 'fr', featureNames: 'fr' });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(
    content.components.filter((c) => c.type === 'gauge').map((g) => g.label),
    ['Noir', 'Noir photo', 'Cyan', 'Magenta', 'Jaune'],
  );
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.slice(2).map((i) => [i.label.fr ?? i.label, i.value]),
    [
      ['Niveau le plus bas', 'Récupérateur · 5 %'],
      ['Récupérateur', '5 %'],
      ['Gris', '80 %'],
    ],
  );
});

test('printer widget: the status list stops at 10 rows', () => {
  const markers = [
    ...['Black', 'Cyan', 'Magenta', 'Yellow'].map((name) =>
      supply(name.toLowerCase(), `${name} Toner`, 'toner', 50),
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      supply(`fuser-${i}`, `Fuser ${i}`, 'fuser', 20 + i, 'snmp'),
    ),
  ];
  const { device, snapshot } = printerWith(markers);
  const content = buildPrinterContent({ device, snapshot, language: 'en', featureNames: 'en' });
  assert.deepEqual(validateWidgetContent(content), []);
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items.length, 10);
  // The lowest part has the 5th gauge; the next ones follow, lowest first.
  assert.deepEqual(
    status.items.slice(3).map((i) => i.value),
    ['21 %', '22 %', '23 %', '24 %', '25 %', '26 %', '27 %'],
  );
});

test('printer widget before the first reading: cartridges first', () => {
  const { device } = printerWith(HP_178NW);
  const reordered = {
    ...device,
    // Parts listed first on the device: the cartridges still come first.
    features: [
      ...device.features.filter((f) => !/toner/i.test(f.name)),
      ...device.features.filter((f) => /toner/i.test(f.name)),
    ],
  };
  const gauges = printerGauges(reordered, undefined, 'fr');
  assert.deepEqual(
    gauges.map((g) => g.label),
    ['Toner noir', 'Toner cyan', 'Toner magenta', 'Toner jaune', 'Unité de transfert'],
  );
});

test('printer widget: printer mode keeps the raw names', () => {
  const { device, snapshot } = printerWith(HP_178NW, { lang: 'printer' });
  assert.deepEqual(
    printerGauges(device, snapshot, 'printer').map((g) => g.label),
    ['Black Toner', 'Cyan Toner', 'Magenta Toner', 'Yellow Toner', 'Transfer Belt'],
  );
  const content = buildPrinterContent({
    device,
    snapshot,
    language: 'en',
    featureNames: 'printer',
  });
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.slice(3).map((i) => i.label),
    ['Fuser Unit', 'Pickup Roller'],
  );
});

test('state reasons are translated, unknown ones kept as reported', () => {
  const label = (reasons, lang) => stateLabel({ state: 'idle', stateReasons: reasons }, lang);
  assert.equal(label(['toner-low'], 'fr'), 'Prête (toner bas)');
  assert.equal(label(['toner-low'], 'en'), 'Idle (toner low)');
  assert.equal(label(['marker-supply-low'], 'fr'), 'Prête (consommable bas)');
  assert.equal(label(['marker-waste-almost-full'], 'fr'), 'Prête (récupérateur presque plein)');
  assert.equal(label(['media-jam', 'cover-open'], 'fr'), 'Prête (bourrage papier, capot ouvert)');
  assert.equal(label(['door-open'], 'en'), 'Idle (door open)');
  assert.equal(label(['some-vendor-reason'], 'fr'), 'Prête (some-vendor-reason)');
  for (const reason of [
    'toner-low',
    'marker-supply-low',
    'toner-empty',
    'marker-supply-empty',
    'media-empty',
    'media-jam',
    'media-needed',
    'door-open',
    'cover-open',
    'offline',
    'paused',
    'marker-waste-almost-full',
    'marker-waste-full',
  ]) {
    const fr = stateLabel({ state: 'stopped', stateReasons: [reason] }, 'fr');
    assert.notEqual(fr, `Arrêtée (${reason})`, reason);
    const en = stateLabel({ state: 'stopped', stateReasons: [reason] }, 'en');
    assert.doesNotMatch(en, /-/, reason);
    assert.ok(fr.length <= 40 && en.length <= 40, fr);
  }
});
