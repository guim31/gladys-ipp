import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  buildPrinterDevice,
  buildPrinterStates,
  platformIdFor,
  pollPrinter,
  PRINTER_URL_PARAM,
} from '../src/device.js';
import { discoverPrinters, mdnsCandidateUrl } from '../src/discovery.js';
import { parsePrinter } from '../src/printer.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { COLOR_INKJET_ATTRIBUTES } from './helpers/ippFixtures.js';

const config = normalizeConfig();
const URL_UNDER_TEST = 'http://192.168.1.20:631/ipp/print';

function probedInkjet() {
  return { printer: parsePrinter(COLOR_INKJET_ATTRIBUTES), url: URL_UNDER_TEST };
}

// --- platform id -------------------------------------------------------------

test('platformIdFor prefers the printer uuid', () => {
  const { printer } = probedInkjet();
  assert.equal(platformIdFor(printer, URL_UNDER_TEST), '12345678-90ab-cdef-1234-567890abcdef');
});

test('platformIdFor falls back to the URL hostname', () => {
  const printer = parsePrinter({});
  assert.equal(platformIdFor(printer, URL_UNDER_TEST), 'host-192-168-1-20');
});

// --- discovery payload -------------------------------------------------------

test('buildPrinterDevice exposes one level sensor per marker plus the state', () => {
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);

  assert.equal(device.name, 'HP OfficeJet Pro 9010');
  assert.equal(device.external_id, 'printer:12345678-90ab-cdef-1234-567890abcdef');
  assert.equal(device.poll_frequency, config.poll_frequency);
  assert.deepEqual(device.params, [{ name: PRINTER_URL_PARAM, value: URL_UNDER_TEST }]);

  assert.equal(device.features.length, 5); // state + 4 cartridges
  const [state, ...markers] = device.features;
  assert.equal(state.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(state.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  assert.equal(state.read_only, true);

  for (const marker of markers) {
    assert.equal(marker.category, DEVICE_FEATURE_CATEGORIES.LEVEL_SENSOR);
    assert.equal(marker.type, DEVICE_FEATURE_TYPES.SENSOR.INTEGER);
    assert.equal(marker.unit, DEVICE_FEATURE_UNITS.PERCENT);
    assert.equal(marker.min, 0);
    assert.equal(marker.max, 100);
    assert.equal(marker.read_only, true);
    assert.equal(marker.keep_history, true);
  }
  assert.equal(
    markers[0].external_id,
    'printer:12345678-90ab-cdef-1234-567890abcdef:marker:black-cartridge',
  );
});

test('buildPrinterDevice skips markers with an unknown level', () => {
  const gladys = createFakeGladys();
  const printer = parsePrinter({
    'marker-names': ['Black', 'Waste'],
    'marker-levels': [50, -2],
  });
  const device = buildPrinterDevice(gladys, { printer, url: URL_UNDER_TEST }, config);
  assert.equal(device.features.length, 2); // state + Black only
});

// --- states ------------------------------------------------------------------

test('buildPrinterStates publishes the state text and every marker percent', () => {
  const gladys = createFakeGladys();
  const states = buildPrinterStates(gladys, probedInkjet());
  assert.equal(states.length, 5);
  assert.deepEqual(states[0], {
    device_feature_external_id: 'printer:12345678-90ab-cdef-1234-567890abcdef:state',
    text: 'idle',
  });
  assert.deepEqual(states[1], {
    device_feature_external_id:
      'printer:12345678-90ab-cdef-1234-567890abcdef:marker:black-cartridge',
    state: 42,
  });
});

// --- polling -----------------------------------------------------------------

test('pollPrinter reads the URL from the device params and publishes states', async () => {
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);

  let requestedUrl = null;
  await pollPrinter(gladys, device, config, {
    fetchAttributes: async (url) => {
      requestedUrl = url;
      return COLOR_INKJET_ATTRIBUTES;
    },
  });

  assert.equal(requestedUrl, URL_UNDER_TEST);
  assert.equal(gladys.published.length, 5);
  assert.equal(gladys.discoveredDevices.length, 0); // features unchanged: no re-publish
});

test('pollPrinter re-publishes the device when a new supply appears', async () => {
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);

  const swapped = {
    ...COLOR_INKJET_ATTRIBUTES,
    'marker-names': [
      'Black XL Cartridge',
      'Cyan Cartridge',
      'Magenta Cartridge',
      'Yellow Cartridge',
    ],
  };
  await pollPrinter(gladys, device, config, {
    fetchAttributes: async () => swapped,
  });

  assert.equal(gladys.discoveredDevices.length, 1);
  const republished = gladys.discoveredDevices[0];
  assert.ok(
    republished.features.some((f) => f.external_id.endsWith('marker:black-xl-cartridge')),
    'the new cartridge feature must exist before its state is published',
  );
});

test('pollPrinter fails loudly when the device has no PRINTER_URL param', async () => {
  const gladys = createFakeGladys();
  await assert.rejects(
    () => pollPrinter(gladys, { external_id: 'printer:x', params: [] }, config),
    /has no PRINTER_URL param/,
  );
});

// --- discovery ---------------------------------------------------------------

test('mdnsCandidateUrl builds the URL from the mDNS entry and its rp TXT', () => {
  const url = mdnsCandidateUrl({
    host: 'printer.local',
    addresses: ['192.168.1.30'],
    port: 631,
    txt: { rp: 'ipp/print' },
  });
  assert.equal(url, 'http://192.168.1.30:631/ipp/print');
});

test('mdnsCandidateUrl skips IPv6 addresses and defaults the path', () => {
  const url = mdnsCandidateUrl({
    host: 'printer.local',
    addresses: ['fe80::1', '192.168.1.31'],
    port: 0,
    txt: {},
  });
  assert.equal(url, 'http://192.168.1.31:631/ipp/print');
});

test('discoverPrinters merges manual targets and mDNS, dedupes by printer', async () => {
  const gladys = createFakeGladys({
    mdnsEntries: [
      { host: 'printer.local', addresses: ['192.168.1.20'], port: 631, txt: { rp: 'ipp/print' } },
    ],
  });
  // The manual entry and the mDNS entry lead to the SAME printer (same uuid).
  const cfg = normalizeConfig({ printer_hosts: '192.168.1.20' });
  const { printers, errors } = await discoverPrinters(gladys, cfg, {
    probe: async () => ({
      url: 'http://192.168.1.20:631/ipp/print',
      attributes: COLOR_INKJET_ATTRIBUTES,
    }),
  });
  assert.equal(printers.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(gladys.scans.length, 1);
  assert.equal(gladys.scans[0].type, 'mdns');
});

test('discoverPrinters keeps working when the mDNS scan is unavailable', async () => {
  const gladys = createFakeGladys({ mdnsEntries: new Error('mediated discovery unsupported') });
  const cfg = normalizeConfig({ printer_hosts: '192.168.1.20' });
  const { printers } = await discoverPrinters(gladys, cfg, {
    probe: async () => ({
      url: 'http://192.168.1.20:631/ipp/print',
      attributes: COLOR_INKJET_ATTRIBUTES,
    }),
  });
  assert.equal(printers.length, 1);
});

test('discoverPrinters collects per-target errors without failing the scan', async () => {
  const gladys = createFakeGladys();
  const cfg = normalizeConfig({ printer_hosts: '192.168.1.20, 192.168.1.99' });
  const { printers, errors } = await discoverPrinters(gladys, cfg, {
    probe: async (target) => {
      if (target.includes('99')) {
        throw new Error('unreachable');
      }
      return { url: 'http://192.168.1.20:631/ipp/print', attributes: COLOR_INKJET_ATTRIBUTES };
    },
  });
  assert.equal(printers.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].target, '192.168.1.99');
});
