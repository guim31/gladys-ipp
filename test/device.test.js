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
  DEVICE_POLL_FREQUENCY_MS,
  isPrinterDevice,
  platformIdFor,
  pollPrinter,
  getPrinterSnapshot,
  PRINTER_URL_PARAM,
  resetPollThrottle,
} from '../src/device.js';
import { discoverPrinters, isIppServiceEntry, mdnsCandidateUrl } from '../src/discovery.js';
import { parsePrinter } from '../src/printer.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { COLOR_INKJET_ATTRIBUTES } from './helpers/ippFixtures.js';
import { buildMarkers } from '../src/printer.js';

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
  // Gladys only accepts values from its DEVICE_POLL_FREQUENCIES list (in ms),
  // and only schedules a poll when should_poll is true (column default: false).
  assert.equal(device.poll_frequency, DEVICE_POLL_FREQUENCY_MS);
  assert.equal(device.should_poll, true);
  assert.deepEqual(device.params, [{ name: PRINTER_URL_PARAM, value: URL_UNDER_TEST }]);

  assert.equal(device.features.length, 5); // state + 4 cartridges
  const [state, ...markers] = device.features;
  assert.equal(state.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(state.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  assert.equal(state.read_only, true);

  for (const marker of markers) {
    assert.equal(marker.category, DEVICE_FEATURE_CATEGORIES.LEVEL_SENSOR);
    assert.equal(marker.type, DEVICE_FEATURE_TYPES.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT);
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

// The Gladys UI resolves a feature icon as DeviceFeatureCategoriesIcon
// [category][type]: a (category, type) pair missing from that table renders
// with NO icon at all. Only these pairs are mapped for the categories we use.
const CATEGORY_TYPES_WITH_ICON = {
  [DEVICE_FEATURE_CATEGORIES.TEXT]: [DEVICE_FEATURE_TYPES.TEXT.TEXT],
  [DEVICE_FEATURE_CATEGORIES.LEVEL_SENSOR]: [
    DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    DEVICE_FEATURE_TYPES.LEVEL_SENSOR.LIQUID_STATE,
    DEVICE_FEATURE_TYPES.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
    DEVICE_FEATURE_TYPES.LEVEL_SENSOR.LIQUID_DEPTH,
  ],
};

test('every published feature carries the fields Gladys requires', () => {
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);
  for (const feature of device.features) {
    // min/max are NOT NULL in the schema with no default: a feature without
    // them makes device creation fail with a 422, whatever its category.
    assert.equal(typeof feature.min, 'number', `feature "${feature.name}" needs a numeric min`);
    assert.equal(typeof feature.max, 'number', `feature "${feature.name}" needs a numeric max`);
    assert.equal(typeof feature.name, 'string');
    assert.ok(feature.external_id, 'each feature needs an external_id');
  }
});

test('every published feature uses a category/type pair that has an icon', () => {
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);
  for (const feature of device.features) {
    const mapped = CATEGORY_TYPES_WITH_ICON[feature.category];
    assert.ok(mapped, `category "${feature.category}" is not covered by this test`);
    assert.ok(
      mapped.includes(feature.type),
      `feature "${feature.name}" (${feature.category}/${feature.type}) would render without an icon`,
    );
  }
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
  resetPollThrottle();
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

test('pollPrinter publishes the state on change, the levels on their interval', async () => {
  resetPollThrottle();
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);
  const stateId = 'printer:12345678-90ab-cdef-1234-567890abcdef:state';

  let clock = 1_000_000;
  let attributes = COLOR_INKJET_ATTRIBUTES;
  const deps = {
    fetchAttributes: async () => attributes,
    now: () => clock,
  };

  await pollPrinter(gladys, device, config, deps); // first poll: state + levels
  assert.equal(gladys.published.length, 5);

  gladys.published.length = 0;
  clock += 15_000;
  await pollPrinter(gladys, device, config, deps); // same state, levels not due
  assert.equal(gladys.published.length, 0, 'an identical idle must not be re-published');

  clock += 15_000;
  attributes = { ...COLOR_INKJET_ATTRIBUTES, 'printer-state': 4 }; // printing starts
  await pollPrinter(gladys, device, config, deps);
  assert.deepEqual(
    gladys.published.map((p) => p.featureExternalId),
    [stateId],
    'a state change must be published immediately, without the levels',
  );
  assert.equal(gladys.published[0].state, 'printing');

  gladys.published.length = 0;
  attributes = COLOR_INKJET_ATTRIBUTES; // back to idle
  clock += config.poll_frequency * 1000;
  await pollPrinter(gladys, device, config, deps); // interval over: levels again
  assert.equal(gladys.published.length, 5);
});

test('buildPrinterStates can omit the levels', () => {
  const gladys = createFakeGladys();
  const states = buildPrinterStates(gladys, probedInkjet(), { withLevels: false });
  assert.equal(states.length, 1);
  assert.equal(states[0].text, 'idle');
});

test('pollPrinter force bypasses the throttle (own refresh loop)', async () => {
  resetPollThrottle();
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);

  let fetches = 0;
  const deps = {
    fetchAttributes: async () => {
      fetches += 1;
      return COLOR_INKJET_ATTRIBUTES;
    },
    now: () => 1_000_000, // frozen clock: the throttle would always refuse
    force: true,
  };

  await pollPrinter(gladys, device, config, deps);
  await pollPrinter(gladys, device, config, deps);
  assert.equal(fetches, 2);
});

test('isPrinterDevice recognizes our devices by their PRINTER_URL param', () => {
  const gladys = createFakeGladys();
  assert.equal(isPrinterDevice(buildPrinterDevice(gladys, probedInkjet(), config)), true);
  assert.equal(isPrinterDevice({ external_id: 'other', params: [] }), false);
  assert.equal(isPrinterDevice({ external_id: 'other' }), false);
  assert.equal(isPrinterDevice(undefined), false);
});

test('pollPrinter re-publishes the device when a new supply appears', async () => {
  resetPollThrottle();
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
      {
        name: 'Printer._ipp._tcp.local',
        host: 'printer.local',
        addresses: ['192.168.1.20'],
        port: 631,
        txt: { rp: 'ipp/print' },
      },
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

test('isIppServiceEntry keeps only genuine _ipp._tcp instances', () => {
  assert.equal(isIppServiceEntry({ name: 'HP LaserJet._ipp._tcp.local' }), true);
  assert.equal(isIppServiceEntry({ name: 'nas._ssh._tcp.local' }), false);
  assert.equal(isIppServiceEntry({ name: 'box._smb._tcp.local' }), false);
  assert.equal(isIppServiceEntry({ name: 'device._matter._tcp.local' }), false);
  assert.equal(isIppServiceEntry({ host: 'x', port: 22 }), false); // no name at all
  assert.equal(isIppServiceEntry(undefined), false);
});

test('discoverPrinters ignores non-printer mDNS entries instead of probing them', async () => {
  // Reproduces the forum case: a chatty LAN where the core mixes SSH/SMB/HA
  // SRV records into the _ipp._tcp scan. Only the real printer must be probed.
  const gladys = createFakeGladys({
    mdnsEntries: [
      {
        name: 'Real Printer._ipp._tcp.local',
        host: 'printer.local',
        addresses: ['192.168.1.26'],
        port: 631,
        txt: { rp: 'ipp/print' },
      },
      { name: 'nas._ssh._tcp.local', host: 'nas.local', addresses: ['192.168.1.94'], port: 22 },
      {
        name: 'server._smb._tcp.local',
        host: 'srv.local',
        addresses: ['192.168.1.250'],
        port: 445,
      },
      {
        name: 'ha._home-assistant._tcp.local',
        host: 'ha.local',
        addresses: ['192.168.1.93'],
        port: 8123,
      },
    ],
  });
  const probed = [];
  const { printers } = await discoverPrinters(gladys, normalizeConfig(), {
    probe: async (target) => {
      probed.push(target);
      return { url: 'http://192.168.1.26:631/ipp/print', attributes: COLOR_INKJET_ATTRIBUTES };
    },
  });
  assert.equal(printers.length, 1);
  assert.deepEqual(
    probed,
    ['http://192.168.1.26:631/ipp/print'],
    'only the real printer must be contacted — never SSH/SMB/HA ports',
  );
});

test('discoverPrinters still probes the manual list when the scan result is not an array', async () => {
  const gladys = createFakeGladys({ mdnsEntries: { unexpected: 'shape' } });
  const cfg = normalizeConfig({ printer_hosts: '192.168.1.20' });
  const { printers } = await discoverPrinters(gladys, cfg, {
    probe: async () => ({
      url: 'http://192.168.1.20:631/ipp/print',
      attributes: COLOR_INKJET_ATTRIBUTES,
    }),
  });
  assert.equal(printers.length, 1);
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

// --- SNMP fallback wiring ----------------------------------------------------

test('pollPrinter only asks SNMP when the levels are due, never on a state sample', async () => {
  resetPollThrottle();
  const gladys = createFakeGladys();
  const stateOnly = { 'printer-name': 'EPSON ET-2810', 'printer-state': 3 };
  const snmpSupplies = [{ name: 'Black ink', color: null, type: 'ink', level: 76, high: 100 }];

  let snmpCalls = 0;
  let clock = 1_000_000;
  let attributes = stateOnly;
  const deps = {
    fetchAttributes: async () => attributes,
    now: () => clock,
    fallbackSupplies: async (printer, url) => {
      snmpCalls += 1;
      assert.equal(url, URL_UNDER_TEST);
      return { ...printer, markers: buildMarkers(snmpSupplies), supplySource: 'snmp' };
    },
  };
  const device = buildPrinterDevice(gladys, probedInkjet(), config);

  await pollPrinter(gladys, device, config, deps); // first poll: levels due
  assert.equal(snmpCalls, 1);
  assert.equal(
    gladys.published.filter((p) => p.state === 76).length,
    1,
    'the SNMP level must reach Gladys like an IPP one',
  );

  clock += 15_000;
  attributes = { ...stateOnly, 'printer-state': 4 }; // state change, levels not due
  gladys.published.length = 0;
  await pollPrinter(gladys, device, config, deps);
  assert.equal(snmpCalls, 1, 'a state sample must not generate SNMP traffic');
  assert.equal(gladys.published.length, 1);

  clock += config.poll_frequency * 1000; // levels due again
  await pollPrinter(gladys, device, config, deps);
  assert.equal(snmpCalls, 2);
});

test('pollPrinter publishes the device when SNMP reveals supplies IPP never announced', async () => {
  resetPollThrottle();
  const gladys = createFakeGladys();
  // A device created while the printer announced nothing: state feature only.
  const device = buildPrinterDevice(
    gladys,
    { printer: { ...probedInkjet().printer, markers: [] }, url: URL_UNDER_TEST },
    config,
  );
  assert.equal(device.features.length, 1);

  await pollPrinter(gladys, device, config, {
    fetchAttributes: async () => ({ 'printer-state': 3 }),
    fallbackSupplies: async (printer) => ({
      ...printer,
      markers: buildMarkers([{ name: 'Black ink', type: 'ink', level: 76, high: 100 }]),
      supplySource: 'snmp',
    }),
  });

  assert.equal(
    gladys.discoveredDevices.length,
    1,
    'the new cartridge feature must be published before its state',
  );
  assert.equal(gladys.discoveredDevices[0].features.length, 2);
});

// --- Snapshots for the dashboard widgets ------------------------------------

test('pollPrinter keeps the last answer of each printer for the widgets', async () => {
  resetPollThrottle();
  const gladys = createFakeGladys();
  const device = buildPrinterDevice(gladys, probedInkjet(), config);
  assert.equal(getPrinterSnapshot(device.external_id), undefined, 'nothing before the first poll');

  let clock = 1_000_000;
  let attributes = COLOR_INKJET_ATTRIBUTES;
  const deps = { fetchAttributes: async () => attributes, now: () => clock };

  const first = await pollPrinter(gladys, device, config, deps);
  assert.deepEqual(first, { published: true, stateChanged: true, withLevels: true });
  const snapshot = getPrinterSnapshot(device.external_id);
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.stateText, 'idle');
  assert.equal(snapshot.at, clock);
  assert.ok(snapshot.markers.some((m) => m.percent !== null));

  // An unchanged state publishes nothing, but the reading time moves on.
  clock += 15_000;
  const quiet = await pollPrinter(gladys, device, config, deps);
  assert.deepEqual(quiet, { published: false, stateChanged: false, withLevels: false });
  assert.equal(getPrinterSnapshot(device.external_id).at, clock);

  // A state-only sample (IPP without the SNMP fallback) keeps the markers
  // of the last levels reading, so an SNMP-only printer never loses them.
  clock += 15_000;
  attributes = { 'printer-name': 'Inkjet', 'printer-state': 4 };
  const changed = await pollPrinter(gladys, device, config, deps);
  assert.equal(changed.stateChanged, true);
  assert.equal(changed.withLevels, false);
  const updated = getPrinterSnapshot(device.external_id);
  assert.equal(updated.state, 'printing');
  assert.deepEqual(updated.markers, snapshot.markers, 'markers survive a state-only sample');

  resetPollThrottle();
  assert.equal(getPrinterSnapshot(device.external_id), undefined);
});
