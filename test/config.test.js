import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parsePrinterHosts, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({ printer_hosts: '192.168.1.20', poll_frequency: 600 });
  assert.equal(config.printer_hosts, '192.168.1.20');
  assert.equal(config.poll_frequency, 600);
});

test('normalizeConfig coerces numeric strings coming from a form', () => {
  const config = normalizeConfig({ poll_frequency: '1200' });
  assert.equal(config.poll_frequency, 1200);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig falls back to the default for a bogus poll_frequency', () => {
  assert.equal(normalizeConfig({ poll_frequency: 'soon' }).poll_frequency, 900);
  assert.equal(normalizeConfig({}).poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('parsePrinterHosts splits on commas, semicolons and whitespace', () => {
  assert.deepEqual(parsePrinterHosts('192.168.1.20, printer.local;\nipp://10.0.0.5/ipp/print'), [
    '192.168.1.20',
    'printer.local',
    'ipp://10.0.0.5/ipp/print',
  ]);
});

test('parsePrinterHosts dedupes and survives an empty value', () => {
  assert.deepEqual(parsePrinterHosts('a, a,, ,a'), ['a']);
  assert.deepEqual(parsePrinterHosts(''), []);
  assert.deepEqual(parsePrinterHosts(undefined), []);
});
