import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanStateReasons, markerPercent, parsePrinter, slugify } from '../src/printer.js';
import { COLOR_INKJET_ATTRIBUTES } from './helpers/ippFixtures.js';

// --- markerPercent -----------------------------------------------------------

test('markerPercent passes plain percentages through', () => {
  assert.equal(markerPercent(42, 100), 42);
  assert.equal(markerPercent(0, 100), 0);
  assert.equal(markerPercent(100, 100), 100);
});

test('markerPercent scales against marker-high-levels', () => {
  assert.equal(markerPercent(128, 255), 50);
  assert.equal(markerPercent(255, 255), 100);
});

test('markerPercent treats negative IPP sentinels as unknown', () => {
  assert.equal(markerPercent(-1, 100), null); // not reported
  assert.equal(markerPercent(-2, 100), null); // unknown
  assert.equal(markerPercent(-3, 100), null); // "some left"
});

test('markerPercent survives a missing or zero high level', () => {
  assert.equal(markerPercent(60, undefined), 60);
  assert.equal(markerPercent(60, 0), 60);
  assert.equal(markerPercent(150, undefined), 100); // clamped
});

test('markerPercent rejects non-numeric levels', () => {
  assert.equal(markerPercent('n/a', 100), null);
  assert.equal(markerPercent(undefined, 100), null);
});

// --- cleanStateReasons -------------------------------------------------------

test('cleanStateReasons drops none and strips severity suffixes', () => {
  assert.deepEqual(cleanStateReasons('none'), []);
  assert.deepEqual(cleanStateReasons(['media-empty-warning', 'toner-low-report']), [
    'media-empty',
    'toner-low',
  ]);
});

test('cleanStateReasons dedupes reasons that differ only by severity', () => {
  assert.deepEqual(cleanStateReasons(['marker-supply-low-warning', 'marker-supply-low-error']), [
    'marker-supply-low',
  ]);
});

// --- slugify -----------------------------------------------------------------

test('slugify produces stable id-friendly tokens', () => {
  assert.equal(slugify('Black Cartridge HP 305'), 'black-cartridge-hp-305');
  assert.equal(slugify('Encre cyan (photo)'), 'encre-cyan-photo');
  assert.equal(slugify('***'), 'unknown');
});

// --- parsePrinter ------------------------------------------------------------

test('parsePrinter maps a full color inkjet answer', () => {
  const printer = parsePrinter(COLOR_INKJET_ATTRIBUTES);
  assert.equal(printer.uuid, '12345678-90ab-cdef-1234-567890abcdef');
  assert.equal(printer.makeAndModel, 'HP OfficeJet Pro 9010');
  assert.equal(printer.state, 'idle');
  assert.equal(printer.stateText, 'idle');
  assert.equal(printer.markers.length, 4);
  assert.deepEqual(
    printer.markers.map((m) => m.key),
    ['black-cartridge', 'cyan-cartridge', 'magenta-cartridge', 'yellow-cartridge'],
  );
  assert.deepEqual(
    printer.markers.map((m) => m.percent),
    [42, 71, 18, 93],
  );
});

test('parsePrinter reports state reasons in the state text', () => {
  const printer = parsePrinter({
    'printer-state': 5,
    'printer-state-reasons': ['media-empty-error', 'input-tray-missing'],
  });
  assert.equal(printer.state, 'stopped');
  assert.equal(printer.stateText, 'stopped (media-empty, input-tray-missing)');
});

test('parsePrinter handles a printer with a single marker (scalar 1setOf)', () => {
  const printer = parsePrinter({
    'printer-state': 4,
    'marker-names': 'Toner',
    'marker-levels': 80,
    'marker-high-levels': 100,
  });
  assert.equal(printer.state, 'printing');
  assert.equal(printer.markers.length, 1);
  assert.equal(printer.markers[0].key, 'toner');
  assert.equal(printer.markers[0].percent, 80);
});

test('parsePrinter dedupes identical marker names', () => {
  const printer = parsePrinter({
    'marker-names': ['Black', 'Black'],
    'marker-levels': [10, 20],
  });
  assert.deepEqual(
    printer.markers.map((m) => m.key),
    ['black', 'black-2'],
  );
});

test('parsePrinter names unnamed markers by position', () => {
  const printer = parsePrinter({ 'marker-levels': [10, 20] });
  assert.deepEqual(
    printer.markers.map((m) => m.name),
    ['Cartridge 1', 'Cartridge 2'],
  );
});

test('parsePrinter tolerates a printer with no marker attributes at all', () => {
  const printer = parsePrinter({ 'printer-state': 3 });
  assert.deepEqual(printer.markers, []);
  assert.equal(printer.uuid, null);
  assert.equal(printer.state, 'idle');
});

test('parsePrinter reports unknown for an exotic printer-state', () => {
  assert.equal(parsePrinter({ 'printer-state': 99 }).state, 'unknown');
  assert.equal(parsePrinter({}).state, 'unknown');
});
