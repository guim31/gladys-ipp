// -----------------------------------------------------------------------------
// SNMP complement: IPP announces the cartridges, the Printer MIB also lists
// the parts (drum/imaging unit, fuser, transfer belt, waste bottle). The parts
// are appended, the IPP markers never move.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkers, markerPercent, parsePrinter } from '../src/printer.js';
import { readSnmpSupplies } from '../src/snmp/supplies.js';
import {
  complementRows,
  resetSupplyFallback,
  SNMP_IDLE_RETRY_MS,
  SNMP_RETRY_MS,
  withFallbackSupplies,
} from '../src/supplies.js';
import { formatSupplies, supplySourceText } from '../src/actions.js';
import { displayMarkerName, shortMarkerName } from '../src/naming.js';
import { lowestMarker } from '../src/widgets.js';
import { startFakeSnmpAgent } from './helpers/fakeSnmpAgent.js';
import { COLOR_INKJET_ATTRIBUTES } from './helpers/ippFixtures.js';

// Documentation addresses (RFC 5737): never a real network.
const SAMSUNG_URL = 'http://192.0.2.10:631/ipp/print';
const HP_URL = 'http://192.0.2.11:631/ipp/print';

/** A Samsung mono laser over IPP: its toner only, with the CRUM serial. */
const SAMSUNG_IPP = {
  'printer-make-and-model': 'Samsung M2070 Series',
  'printer-state': 3,
  'marker-names': 'Black Toner_S/N_:CRUM-00000000000',
  'marker-types': 'toner',
  'marker-colors': '#000000',
  'marker-levels': 70,
  'marker-high-levels': 100,
};

/** The same Samsung over SNMP: the toner again, and the imaging unit in pages. */
const SAMSUNG_MIB = {
  '1.3.6.1.2.1.43.11.1.1.5.1.1': 3, // toner
  '1.3.6.1.2.1.43.11.1.1.5.1.2': 9, // opc
  '1.3.6.1.2.1.43.11.1.1.6.1.1': 'Black Toner S/N:CRUM-00000000000',
  '1.3.6.1.2.1.43.11.1.1.6.1.2': 'Imaging Unit',
  '1.3.6.1.2.1.43.11.1.1.8.1.1': 100,
  '1.3.6.1.2.1.43.11.1.1.8.1.2': 30000,
  '1.3.6.1.2.1.43.11.1.1.9.1.1': 70,
  '1.3.6.1.2.1.43.11.1.1.9.1.2': 2400,
};

/** An HP color laser over IPP: its four toners. */
const HP_IPP = {
  'printer-make-and-model': 'HP Color LaserJet Pro M479fdw',
  'printer-state': 3,
  'marker-names': ['black cartridge', 'cyan cartridge', 'magenta cartridge', 'yellow cartridge'],
  'marker-types': ['toner-cartridge', 'toner-cartridge', 'toner-cartridge', 'toner-cartridge'],
  'marker-levels': [55, 40, 62, 18],
  'marker-high-levels': [100, 100, 100, 100],
};

/** The same HP over SNMP: four toners, then fuser, transfer belt, waste. */
const HP_SNMP_ROWS = [
  { name: 'Black Cartridge HP W2030A', color: null, type: 'toner', level: 55, high: 100 },
  { name: 'Cyan Cartridge HP W2031A', color: null, type: 'toner', level: 40, high: 100 },
  { name: 'Magenta Cartridge HP W2033A', color: null, type: 'toner', level: 62, high: 100 },
  { name: 'Yellow Cartridge HP W2032A', color: null, type: 'toner', level: 18, high: 100 },
  { name: 'Fuser Kit', color: null, type: 'fuser', level: 81, high: 100 },
  { name: 'Transfer Belt', color: null, type: 'transfer-unit', level: 64, high: 100 },
  { name: 'Toner Collection Unit', color: null, type: 'waste-toner', level: -3, high: 100 },
];

const rowsOnce = (rows) => async () => rows;

test('Samsung mono: the IPP toner stays intact, the SNMP imaging unit is added', async () => {
  resetSupplyFallback();
  const agent = await startFakeSnmpAgent(SAMSUNG_MIB);
  try {
    const ipp = parsePrinter(SAMSUNG_IPP);
    const result = await withFallbackSupplies(ipp, SAMSUNG_URL, {
      readSupplies: (host) => {
        assert.equal(host, '192.0.2.10', 'unicast to the printer only');
        return readSnmpSupplies('127.0.0.1', { port: agent.port });
      },
    });

    assert.equal(result.supplySource, 'ipp+snmp');
    assert.equal(result.markers.length, 2, 'the SNMP toner is not doubled');
    assert.deepEqual(result.markers[0], ipp.markers[0], 'the IPP marker is untouched');
    assert.equal(result.markers[0].key, 'black-toner-s-n-crum-00000000000');
    const drum = result.markers[1];
    assert.equal(drum.key, 'imaging-unit');
    assert.equal(drum.name, 'Imaging Unit');
    assert.equal(drum.type, 'opc');
    assert.equal(drum.source, 'snmp');
    assert.equal(drum.percent, 8, '2400 pages left out of 30000');

    // Names: the feature, the widget tile, the lowest supply.
    assert.equal(displayMarkerName(drum, 'fr'), "Unité d'imagerie");
    assert.equal(displayMarkerName(drum, 'en'), 'Imaging unit');
    assert.equal(displayMarkerName(drum, 'printer'), 'Imaging Unit');
    assert.equal(shortMarkerName(drum, 'fr'), 'Tambour');
    assert.equal(lowestMarker({ markers: result.markers }), drum);

    // The test button names where each level comes from.
    assert.deepEqual(supplySourceText(result), {
      en: ' (+ SNMP: Imaging Unit)',
      fr: ' (+ SNMP : Imaging Unit)',
    });
    assert.equal(
      formatSupplies(result, 'en'),
      'Black Toner_S/N_:CRUM-00000000000: 70%, Imaging Unit: 8%',
    );
  } finally {
    await agent.close();
  }
});

test('HP color: fuser, transfer belt and waste are added, no toner is doubled', async () => {
  resetSupplyFallback();
  const ipp = parsePrinter(HP_IPP);
  const result = await withFallbackSupplies(ipp, HP_URL, {
    readSupplies: rowsOnce(HP_SNMP_ROWS),
  });

  assert.deepEqual(result.markers.slice(0, 4), ipp.markers, 'the four IPP toners never move');
  assert.deepEqual(
    result.markers.slice(4).map((m) => [m.key, m.type, m.percent]),
    [
      ['fuser-kit', 'fuser', 81],
      ['transfer-belt', 'transfer-unit', 64],
      ['toner-collection-unit', 'waste-toner', null],
    ],
  );
  assert.equal(result.markers.filter((m) => /cartridge/i.test(m.name)).length, 4, 'no SNMP toner');
  // Every supply is listed by the test button, a level-less one with its
  // raw sentinel explained.
  assert.match(formatSupplies(result, 'fr'), /Toner Collection Unit: il en reste \(-3\)$/);
  assert.equal(
    supplySourceText(result).en,
    ' (+ SNMP: Fuser Kit, Transfer Belt, Toner Collection Unit)',
  );
  assert.equal(displayMarkerName(result.markers[4], 'fr'), 'Four');
  assert.equal(displayMarkerName(result.markers[5], 'fr'), 'Unité de transfert');
  assert.equal(displayMarkerName(result.markers[6], 'fr'), 'Récupérateur de toner');
});

test('a silent SNMP agent leaves the IPP markers unchanged and backs off', async () => {
  resetSupplyFallback();
  const agent = await startFakeSnmpAgent(SAMSUNG_MIB, { silent: true });
  try {
    let clock = 1_000_000;
    let calls = 0;
    const deps = {
      readSupplies: () => {
        calls += 1;
        return readSnmpSupplies('127.0.0.1', { port: agent.port, timeoutMs: 100 });
      },
      now: () => clock,
    };
    const ipp = parsePrinter(SAMSUNG_IPP);
    const result = await withFallbackSupplies(ipp, SAMSUNG_URL, deps);
    assert.equal(result, ipp, 'same printer, same markers');
    assert.equal(calls, 1);

    clock += SNMP_RETRY_MS - 1;
    await withFallbackSupplies(ipp, SAMSUNG_URL, deps);
    assert.equal(calls, 1, 'no retry inside the back-off window');

    await withFallbackSupplies(ipp, SAMSUNG_URL, { ...deps, ignoreBackoff: true });
    assert.equal(calls, 2, 'the test button always asks');

    clock += SNMP_RETRY_MS + 1;
    await withFallbackSupplies(ipp, SAMSUNG_URL, deps);
    assert.equal(calls, 3, 'another chance once the window is over');
  } finally {
    await agent.close();
  }
});

test('an SNMP answer with nothing to add backs off longer, a useful one does not', async () => {
  resetSupplyFallback();
  let clock = 1_000_000;
  let calls = 0;
  let rows = [{ name: 'Black ink', color: null, type: 'ink', level: 76, high: 100 }];
  const deps = {
    readSupplies: async () => {
      calls += 1;
      return rows;
    },
    now: () => clock,
  };
  const ipp = parsePrinter(COLOR_INKJET_ATTRIBUTES);

  assert.equal(await withFallbackSupplies(ipp, HP_URL, deps), ipp);
  clock += SNMP_RETRY_MS + 1;
  await withFallbackSupplies(ipp, HP_URL, deps);
  assert.equal(calls, 1, 'a conclusive "nothing to add" is not retried after 30 min');
  clock += SNMP_IDLE_RETRY_MS;
  await withFallbackSupplies(ipp, HP_URL, deps);
  assert.equal(calls, 2);

  // A part with a level: read again at every levels reading.
  rows = [{ name: 'Maintenance Box', color: null, type: 'waste-ink', level: 90, high: 100 }];
  clock += SNMP_IDLE_RETRY_MS;
  await withFallbackSupplies(ipp, HP_URL, deps);
  await withFallbackSupplies(ipp, HP_URL, deps);
  assert.equal(calls, 4);
});

test('complementRows: an unknown type only counts when its name is a part', () => {
  const ipp = parsePrinter(HP_IPP).markers;
  const rows = complementRows(ipp, [
    { name: 'Staple Cartridge', type: null, level: 10, high: 100 },
    { name: 'Supply 7', type: null, level: 10, high: 100 },
    { name: 'Drum Unit', type: null, level: 30, high: 100 },
    { name: 'Toner/Drum kit', type: 'toner', level: 30, high: 100 },
    { name: 'Black Ink Ribbon', type: 'ink-ribbon', level: 30, high: 100 },
    { name: 'Toner Cartridge', type: 'toner-cartridge', level: 30, high: 100 },
  ]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Drum Unit'],
  );
});

test('complementRows: a part IPP already announces is never added twice', () => {
  const ipp = buildMarkers([
    { name: 'Black Toner', type: 'toner', level: 50, high: 100 },
    { name: 'Drum', type: null, level: 50, high: 100 }, // same part, by name
    { name: 'Waste', type: 'waste-toner', level: 50, high: 100 }, // same type
    { name: 'Maintenance Kit', type: null, level: 50, high: 100 }, // same key
  ]);
  const rows = complementRows(ipp, [
    { name: 'Imaging Unit', type: 'opc', level: 10, high: 100 },
    { name: 'Toner Collection Unit', type: 'waste-toner', level: 10, high: 100 },
    { name: 'Maintenance Kit', type: 'fuser', level: 10, high: 100 },
    { name: 'Transfer Roller', type: 'transfer-unit', level: 10, high: 100 },
    { name: 'Transfer Roller', type: 'transfer-unit', level: 10, high: 100 },
  ]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Transfer Roller'],
    'only the transfer roller is new, and only once',
  );
});

test('the IPP feature keys are those of v1.1.0, complement or not', async () => {
  resetSupplyFallback();
  const V1_1_0_KEYS = [
    'black-cartridge',
    'cyan-cartridge',
    'magenta-cartridge',
    'yellow-cartridge',
  ];
  const ipp = parsePrinter(COLOR_INKJET_ATTRIBUTES);
  assert.deepEqual(
    ipp.markers.map((m) => m.key),
    V1_1_0_KEYS,
  );
  const result = await withFallbackSupplies(ipp, HP_URL, {
    readSupplies: rowsOnce([
      { name: 'Black Cartridge', type: 'opc', level: 10, high: 100 }, // key taken: skipped
      { name: 'Maintenance Box', type: 'waste-ink', level: 90, high: 100 },
    ]),
  });
  assert.deepEqual(
    result.markers.map((m) => m.key),
    [...V1_1_0_KEYS, 'maintenance-box'],
  );
});

test('markerPercent scales a page-counted part (Samsung drum, fuser)', () => {
  assert.equal(markerPercent(2400, 30000), 8);
  assert.equal(markerPercent(30000, 30000), 100);
  assert.equal(markerPercent(150000, 100000), 100, 'clamped');
  for (const sentinel of [-1, -2, -3]) {
    assert.equal(markerPercent(sentinel, 30000), null);
  }
});
