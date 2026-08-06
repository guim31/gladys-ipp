import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSupplies } from '../src/actions.js';
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
