import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayMarkerName, displayStateName } from '../src/naming.js';
import { buildPrinterDevice } from '../src/device.js';
import { parsePrinter } from '../src/printer.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { COLOR_INKJET_ATTRIBUTES } from './helpers/ippFixtures.js';

const marker = (name, type = 'ink-cartridge') => ({ name, type });

test('printer mode keeps the raw names untouched', () => {
  assert.equal(displayMarkerName(marker('black cartridge'), 'printer'), 'black cartridge');
  assert.equal(displayStateName('printer'), 'State');
});

test('french names for common inkjet supplies', () => {
  assert.equal(displayMarkerName(marker('black cartridge'), 'fr'), 'Encre noire');
  assert.equal(displayMarkerName(marker('cyan cartridge'), 'fr'), 'Encre cyan');
  assert.equal(displayMarkerName(marker('yellow cartridge'), 'fr'), 'Encre jaune');
  assert.equal(displayStateName('fr'), 'État');
});

test('toner names carry the masculine adjective in french', () => {
  assert.equal(
    displayMarkerName(marker('Black Toner_S/N_:CRUM-25111822430', 'toner'), 'fr'),
    'Toner noir',
  );
  assert.equal(displayMarkerName(marker('Gray Toner', 'toner'), 'fr'), 'Toner gris');
});

test('composite shades match before their base color', () => {
  assert.equal(displayMarkerName(marker('photo black ink'), 'en'), 'Photo black ink');
  assert.equal(displayMarkerName(marker('light cyan'), 'fr'), 'Encre cyan clair');
});

test('waste containers and unrecognized names', () => {
  assert.equal(
    displayMarkerName(marker('waste toner container', 'other'), 'fr'),
    'Récupérateur de toner',
  );
  assert.equal(
    displayMarkerName(marker('Mystery Supply 42', 'other'), 'fr'),
    'Mystery Supply 42',
    'an unrecognized supply must keep its raw name, never worse than before',
  );
});

test('inkjet waste containers are not called toner containers', () => {
  // Typical of the SNMP Printer MIB on an EcoTank: "Maintenance Box" with
  // supply type wasteInk.
  assert.equal(
    displayMarkerName(marker('Maintenance Box', 'waste-ink'), 'fr'),
    "Bac de récupération d'encre",
  );
  assert.equal(displayMarkerName(marker('Waste Ink', 'waste-ink'), 'en'), 'Waste ink container');
});

test('english mode normalizes the raw names', () => {
  assert.equal(displayMarkerName(marker('BLACK CARTRIDGE HP 305'), 'en'), 'Black ink');
  assert.equal(displayMarkerName(marker('Cyan Toner', 'toner'), 'en'), 'Cyan toner');
});

test('the language changes the names but NEVER the external_ids', () => {
  const gladys = createFakeGladys();
  const printer = parsePrinter(COLOR_INKJET_ATTRIBUTES);
  const raw = buildPrinterDevice(gladys, { printer, url: 'http://x:631/ipp' }, normalizeConfig());
  const fr = buildPrinterDevice(
    gladys,
    { printer, url: 'http://x:631/ipp' },
    normalizeConfig({ feature_names: 'fr' }),
  );
  assert.deepEqual(
    fr.features.map((f) => f.external_id),
    raw.features.map((f) => f.external_id),
    'switching language must not orphan existing features or their history',
  );
  assert.deepEqual(
    fr.features.map((f) => f.name),
    ['État', 'Encre noire', 'Encre cyan', 'Encre magenta', 'Encre jaune'],
  );
});
