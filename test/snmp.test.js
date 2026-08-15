// -----------------------------------------------------------------------------
// SNMP fallback: BER primitives, the walk (against a real local UDP agent),
// the Printer MIB mapping, and the traffic discipline of the fallback itself.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareOids,
  decodeInteger,
  decodeOidValue,
  encodeInteger,
  encodeLength,
  encodeOidValue,
  isUnder,
} from '../src/snmp/ber.js';
import { snmpWalk } from '../src/snmp/client.js';
import { readSnmpSupplies, SUPPLY_COLUMNS } from '../src/snmp/supplies.js';
import {
  hostOf,
  resetSupplyFallback,
  SNMP_RETRY_MS,
  withFallbackSupplies,
} from '../src/supplies.js';
import { ECOTANK_MIB, startFakeSnmpAgent } from './helpers/fakeSnmpAgent.js';

// --- BER ---------------------------------------------------------------------

test('encodeLength uses the short form below 128 and the long form above', () => {
  assert.deepEqual([...encodeLength(5)], [5]);
  assert.deepEqual([...encodeLength(127)], [127]);
  assert.deepEqual([...encodeLength(128)], [0x81, 128]);
  assert.deepEqual([...encodeLength(300)], [0x82, 1, 44]);
});

test('integers round-trip, negative sentinels included', () => {
  for (const value of [0, 1, 127, 128, 255, 256, 65535, -1, -2, -3, -129]) {
    assert.equal(decodeInteger(encodeInteger(value)), value, `round-trip of ${value}`);
  }
});

test('encodeInteger stays minimal', () => {
  assert.deepEqual([...encodeInteger(0)], [0]);
  assert.deepEqual([...encodeInteger(-1)], [0xff]);
  // 128 needs a leading zero byte or it would read as -128.
  assert.deepEqual([...encodeInteger(128)], [0x00, 0x80]);
});

test('OIDs round-trip, multi-byte arcs included', () => {
  for (const oid of [
    '1.3.6.1.2.1.43.11.1.1.9.1.1',
    '1.3.6.1.4.1.1248',
    '1.3.6.1.2.1.43.11.1.1.9.1.300',
  ]) {
    assert.equal(decodeOidValue(encodeOidValue(oid)), oid);
  }
});

test('isUnder only matches a real subtree, not a name prefix', () => {
  assert.equal(isUnder('1.3.6.1.2.1.43.11.1.1.9.1.1', '1.3.6.1.2.1.43.11.1.1.9'), true);
  assert.equal(isUnder('1.3.6.1.2.1.43.11.1.1.9', '1.3.6.1.2.1.43.11.1.1.9'), true);
  // .91 must NOT count as being under .9
  assert.equal(isUnder('1.3.6.1.2.1.43.11.1.1.91.1', '1.3.6.1.2.1.43.11.1.1.9'), false);
});

test('compareOids compares arc by arc, not as text', () => {
  assert.ok(compareOids('1.3.6.1.2.1.43.11.1.1.9.1.2', '1.3.6.1.2.1.43.11.1.1.9.1.10') < 0);
  assert.equal(compareOids('1.3.6.1', '1.3.6.1'), 0);
});

// --- walk against a real UDP agent -------------------------------------------

test('snmpWalk collects a whole table column and stops at the subtree end', async () => {
  const agent = await startFakeSnmpAgent(ECOTANK_MIB);
  try {
    const rows = await snmpWalk('127.0.0.1', SUPPLY_COLUMNS.level, { port: agent.port });
    assert.deepEqual(
      rows.map((r) => r.value),
      [76, 51, 33, -2, 90],
    );
    assert.equal(rows[0].oid, '1.3.6.1.2.1.43.11.1.1.9.1.1');
    // 5 rows + the request that walked past the end of the column.
    assert.equal(agent.requests.length, 6);
  } finally {
    await agent.close();
  }
});

test('snmpWalk returns nothing (and never throws) when the printer stays silent', async () => {
  const agent = await startFakeSnmpAgent(ECOTANK_MIB, { silent: true });
  try {
    const rows = await snmpWalk('127.0.0.1', SUPPLY_COLUMNS.level, {
      port: agent.port,
      timeoutMs: 150,
    });
    assert.deepEqual(rows, []);
  } finally {
    await agent.close();
  }
});

// --- Printer MIB -> supply rows ----------------------------------------------

test('readSnmpSupplies joins the level, description, capacity and type columns', async () => {
  const agent = await startFakeSnmpAgent(ECOTANK_MIB);
  try {
    const supplies = await readSnmpSupplies('127.0.0.1', { port: agent.port });
    assert.equal(supplies.length, 5);
    assert.deepEqual(supplies[0], {
      name: 'Black ink',
      color: null,
      type: 'ink',
      level: 76,
      high: 100,
    });
    assert.equal(supplies[4].name, 'Maintenance Box');
    assert.equal(supplies[4].type, 'waste-ink');
  } finally {
    await agent.close();
  }
});

test('readSnmpSupplies gives up quietly on a printer without the Printer MIB', async () => {
  const agent = await startFakeSnmpAgent({ '1.3.6.1.2.1.1.5.0': 'a switch, not a printer' });
  try {
    assert.deepEqual(await readSnmpSupplies('127.0.0.1', { port: agent.port }), []);
  } finally {
    await agent.close();
  }
});

// --- the fallback and its traffic discipline ---------------------------------

test('hostOf extracts the hostname, IPv6 brackets stripped', () => {
  assert.equal(hostOf('https://192.168.1.51:631/ipp/print'), '192.168.1.51');
  assert.equal(hostOf('http://[fe80::1]:631/ipp/print'), 'fe80::1');
});

test('withFallbackSupplies never queries SNMP when IPP already announced supplies', async () => {
  resetSupplyFallback();
  let called = 0;
  const printer = { markers: [{ key: 'black', name: 'Black', percent: 42 }] };
  const result = await withFallbackSupplies(printer, 'http://192.168.1.20:631/ipp/print', {
    readSupplies: async () => {
      called += 1;
      return [];
    },
  });
  assert.equal(called, 0, 'a working printer must not generate a single SNMP packet');
  assert.equal(result, printer);
});

test('withFallbackSupplies fills the markers from SNMP when IPP announced none', async () => {
  resetSupplyFallback();
  const printer = { markers: [], stateText: 'idle' };
  const result = await withFallbackSupplies(printer, 'https://192.168.1.51:631/ipp/print', {
    readSupplies: async (host) => {
      assert.equal(host, '192.168.1.51');
      return [
        { name: 'Black ink', color: null, type: 'ink', level: 76, high: 100 },
        { name: 'Maintenance Box', color: null, type: 'waste-ink', level: -2, high: 100 },
      ];
    },
  });
  assert.equal(result.supplySource, 'snmp');
  assert.equal(result.markers.length, 2);
  assert.equal(result.markers[0].key, 'black-ink');
  assert.equal(result.markers[0].percent, 76);
  assert.equal(result.markers[1].percent, null, 'the -2 sentinel keeps its IPP meaning');
  assert.equal(result.markers[1].rawLevel, -2);
  assert.equal(result.stateText, 'idle', 'the rest of the printer is untouched');
});

test('withFallbackSupplies backs off after a miss, then retries later', async () => {
  resetSupplyFallback();
  let called = 0;
  let clock = 1_000_000;
  const deps = {
    readSupplies: async () => {
      called += 1;
      return [];
    },
    now: () => clock,
  };
  const printer = { markers: [] };
  const url = 'http://192.168.1.51:631/ipp/print';

  await withFallbackSupplies(printer, url, deps);
  assert.equal(called, 1);

  // Every poll in the back-off window must stay silent on the network.
  clock += SNMP_RETRY_MS - 1;
  await withFallbackSupplies(printer, url, deps);
  assert.equal(called, 1, 'no retry inside the back-off window');

  clock += 2;
  await withFallbackSupplies(printer, url, deps);
  assert.equal(called, 2, 'the printer gets another chance once the window is over');
});

test('the manual test button bypasses the back-off', async () => {
  resetSupplyFallback();
  let called = 0;
  const deps = {
    readSupplies: async () => {
      called += 1;
      return [];
    },
    now: () => 1_000_000,
  };
  await withFallbackSupplies({ markers: [] }, 'http://192.168.1.51:631/ipp/print', deps);
  await withFallbackSupplies({ markers: [] }, 'http://192.168.1.51:631/ipp/print', {
    ...deps,
    ignoreBackoff: true,
  });
  assert.equal(called, 2, 'pressing the button must really query the printer');
});

test('withFallbackSupplies survives an SNMP layer that throws', async () => {
  resetSupplyFallback();
  const printer = { markers: [], stateText: 'idle' };
  const result = await withFallbackSupplies(printer, 'http://192.168.1.51:631/ipp/print', {
    readSupplies: async () => {
      throw new Error('EHOSTUNREACH');
    },
  });
  assert.deepEqual(result.markers, [], 'the state feature keeps working');
});
