import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayMarkerName, displayStateName, markerPart, shortMarkerName } from '../src/naming.js';
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

test('printer parts get their own name, no longer "Encre noire"', () => {
  assert.equal(displayMarkerName(marker('Black Drum Unit', 'opc'), 'fr'), 'Tambour noir');
  assert.equal(displayMarkerName(marker('Black Drum Unit', 'opc'), 'en'), 'Black drum');
  assert.equal(displayMarkerName(marker('Drum Unit', null), 'fr'), 'Tambour');
  assert.equal(displayMarkerName(marker('Imaging Unit', 'opc'), 'fr'), "Unité d'imagerie");
  assert.equal(displayMarkerName(marker('Imaging Unit', 'opc'), 'en'), 'Imaging unit');
  assert.equal(
    displayMarkerName(marker('Cyan Imaging Unit', 'opc'), 'fr'),
    "Unité d'imagerie cyan",
  );
  assert.equal(
    displayMarkerName(marker('Black Imaging Unit', 'opc'), 'fr'),
    "Unité d'imagerie noire",
  );
  assert.equal(displayMarkerName(marker('Fuser Kit', 'fuser'), 'en'), 'Fuser');
  assert.equal(
    displayMarkerName(marker('Transfer Belt', 'transfer-unit'), 'fr'),
    'Unité de transfert',
  );
  assert.equal(displayMarkerName(marker('Developer Unit', 'developer'), 'fr'), 'Développeur');
});

test('cartridges keep their rule, even when the name mentions a part', () => {
  assert.equal(displayMarkerName(marker('Black Toner', 'toner'), 'fr'), 'Toner noir');
  assert.equal(displayMarkerName(marker('Black Toner/Drum', 'toner'), 'fr'), 'Toner noir');
  assert.equal(displayMarkerName(marker('black cartridge'), 'fr'), 'Encre noire');
  assert.equal(shortMarkerName({ name: 'Black Toner/Drum', type: 'toner' }, 'fr'), 'Noir');
});

test('markerPart identifies the part across sources, never a cartridge', () => {
  assert.equal(markerPart({ name: 'Imaging Unit', type: 'opc' }), 'drum');
  assert.equal(markerPart({ name: 'Drum', type: null }), 'drum');
  assert.equal(markerPart({ name: 'Supply 2', type: 'opc' }), 'drum');
  assert.equal(markerPart({ name: 'Toner Collection Unit', type: 'waste-toner' }), 'waste');
  assert.equal(markerPart({ name: 'Maintenance Box', type: null }), 'waste');
  assert.equal(markerPart({ name: 'Fuser Kit', type: null }), 'fuser');
  assert.equal(markerPart({ name: 'Black Toner', type: 'toner' }), null);
  assert.equal(markerPart({ name: 'Toner/Drum kit', type: 'toner' }), null);
  assert.equal(markerPart({ name: 'Staple Cartridge', type: null }), null);
});

test('shortMarkerName: an imaging unit is a drum on a tile', () => {
  assert.equal(shortMarkerName({ name: 'Imaging Unit', type: 'opc' }, 'fr'), 'Tambour');
  assert.equal(shortMarkerName({ name: 'Imaging Unit', type: 'opc' }, 'en'), 'Drum');
});

// --- Short names for the widget tiles ----------------------------------------

test('shortMarkerName: the color alone for a cartridge, the part otherwise', () => {
  assert.equal(shortMarkerName({ name: 'black cartridge', type: 'ink' }, 'fr'), 'Noir');
  assert.equal(shortMarkerName({ name: 'Cyan Toner Cartridge', type: 'toner' }, 'en'), 'Cyan');
  assert.equal(shortMarkerName({ name: 'Photo Black Ink', type: 'ink' }, 'fr'), 'Noir photo');
  assert.equal(shortMarkerName({ name: 'Black Drum Unit', type: 'opc' }, 'fr'), 'Tambour noir');
  assert.equal(shortMarkerName({ name: 'Drum Unit', type: null }, 'en'), 'Drum');
  assert.equal(shortMarkerName({ name: 'Fuser Unit', type: null }, 'fr'), 'Four');
  assert.equal(shortMarkerName({ name: 'Maintenance Box', type: null }, 'fr'), 'Récupérateur');
  assert.equal(shortMarkerName({ name: 'Waste Toner Bottle', type: null }, 'en'), 'Waste');
  // Unrecognized: the raw name, as the feature itself is named.
  assert.equal(shortMarkerName({ name: 'Cartridge 1', type: null }, 'fr'), 'Cartridge 1');
});

test('shortMarkerName: raw names are kept but shortened to a tile label', () => {
  assert.equal(
    shortMarkerName({ name: 'Black Toner_S/N_:CRUM-25111822430', type: 'toner' }, 'printer'),
    'Black Toner',
  );
  const long = shortMarkerName(
    { name: 'A very very very long cartridge name', type: null },
    'printer',
  );
  assert.ok(long.length <= 24);
  assert.ok(long.endsWith('…'));
  assert.equal(shortMarkerName({ name: '', type: null }, 'en'), 'Cartridge');
});
