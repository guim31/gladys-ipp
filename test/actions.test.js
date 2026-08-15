import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSupplies, noSupplyDiagnostic } from '../src/actions.js';
import { parsePrinter } from '../src/printer.js';

// The test action is the diagnostic tool for "my cartridge is missing":
// it must show EVERY supply, with the raw IPP sentinel explained.

test('formatSupplies shows plain percentages', () => {
  const printer = parsePrinter({ 'marker-names': ['Black'], 'marker-levels': [42] });
  assert.equal(formatSupplies(printer, 'en'), 'Black: 42%');
});

test('formatSupplies explains the IPP sentinels instead of hiding the supply', () => {
  const printer = parsePrinter({
    'marker-names': ['Black', 'Cyan', 'Yellow', 'Waste'],
    'marker-levels': [-2, 50, -3, -1],
  });
  assert.equal(
    formatSupplies(printer, 'en'),
    'Black: unknown (-2), Cyan: 50%, Yellow: some left (-3), Waste: not reported (-1)',
  );
  assert.equal(
    formatSupplies(printer, 'fr'),
    'Black: inconnu (-2), Cyan: 50%, Yellow: il en reste (-3), Waste: non communiqué (-1)',
  );
});

test('formatSupplies flags a value missing from marker-levels', () => {
  const printer = parsePrinter({
    'marker-names': ['Black', 'Cyan'],
    'marker-levels': [30],
  });
  assert.equal(formatSupplies(printer, 'en'), 'Black: 30%, Cyan: missing from marker-levels');
});

// When NOTHING was parsed, the test action must say why — that answer is
// what users paste on the forum, it decides the next debugging step.

test('noSupplyDiagnostic lists supply-ish attributes the parser missed', () => {
  const { en, fr } = noSupplyDiagnostic({
    'printer-state': 3,
    'epson-ink-info': 'something-proprietary',
  });
  assert.match(en, /unexploited attributes: epson-ink-info/);
  assert.match(fr, /attributs non exploités : epson-ink-info/);
});

test('noSupplyDiagnostic states when neither IPP nor SNMP announced anything', () => {
  const { en, fr } = noSupplyDiagnostic({ 'printer-state': 3, 'printer-name': 'X' });
  assert.equal(en, 'no supply announced, over IPP nor SNMP');
  assert.equal(fr, 'aucun consommable annoncé, ni en IPP ni en SNMP');
});
