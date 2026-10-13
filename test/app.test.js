// -----------------------------------------------------------------------------
// Wiring of src/app.js against the fake Gladys of the SDK: the integration
// samples the created printers by its own loop (Gladys 5.2.0 never polls a
// device created without should_poll, GladysAssistant/Gladys#3198), onPoll
// is a fallback that never doubles a recent sample, and a normal cycle
// writes nothing in info.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ON_POLL_SKIP_MS, STATE_SAMPLING_MS, registerIntegration } from '../src/app.js';
import { buildPrinterDevice, resetPollThrottle } from '../src/device.js';
import { parsePrinter } from '../src/printer.js';
import { COLOR_INKJET_ATTRIBUTES } from './helpers/ippFixtures.js';

const URL_UNDER_TEST = 'http://192.0.2.20:631/ipp/print';

/**
 * A fake Gladys holding one created printer, the integration registered on
 * it with stubbed IPP access, a manual clock and captured timers.
 * @param {{ createdWithoutPolling?: boolean }} [options] the device as an
 *   older version created it: no should_poll, no poll_frequency
 */
function setup({ createdWithoutPolling = false } = {}) {
  resetPollThrottle();
  const gladys = createFakeGladys({ config: { poll_frequency: 900 } });
  const published = buildPrinterDevice(gladys, {
    printer: parsePrinter(COLOR_INKJET_ATTRIBUTES),
    url: URL_UNDER_TEST,
  });
  const device = createdWithoutPolling
    ? { ...published, should_poll: false, poll_frequency: null }
    : published;
  gladys.fake.devices = [device];

  const clock = { at: 1_000_000 };
  const now = () => clock.at;
  const ipp = { calls: 0, fail: null, attributes: COLOR_INKJET_ATTRIBUTES };
  const timers = [];
  const integration = registerIntegration(gladys, {
    now,
    pollDeps: {
      now,
      fetchAttributes: async () => {
        ipp.calls += 1;
        if (ipp.fail) {
          throw ipp.fail;
        }
        return ipp.attributes;
      },
      fallbackSupplies: async (printer) => printer,
    },
    discoveryDeps: { scanTimeoutSeconds: 1 },
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });

  /** Fire the armed loop timer (one round), as the 15 s timer would. */
  async function tick() {
    const timer = timers.findLast((candidate) => !candidate.cleared);
    assert.ok(timer, 'the sampling loop must be armed');
    timer.cleared = true;
    clock.at += timer.delay;
    await timer.callback();
  }

  return { gladys, device, integration, ipp, clock, timers, tick };
}

/** Capture the SDK logger lines (info goes to console.log, warn to console.error). */
function captureLogs(t) {
  const lines = { info: [], warn: [] };
  t.mock.method(console, 'log', (...args) => {
    const line = args.join(' ');
    if (line.includes('[INFO]')) {
      lines.info.push(line);
    }
  });
  t.mock.method(console, 'error', (...args) => {
    lines.warn.push(args.join(' '));
  });
  return lines;
}

test('the integration samples a created printer by itself, without any onPoll', async () => {
  const { gladys, device, ipp, timers, tick } = setup({ createdWithoutPolling: true });
  await gladys.connect();
  assert.equal(ipp.calls, 1, 'one forced sample on connection');
  assert.equal(timers.at(-1).delay, STATE_SAMPLING_MS);

  ipp.attributes = { ...COLOR_INKJET_ATTRIBUTES, 'printer-state': 4 }; // printing
  await tick();
  await tick();
  assert.equal(ipp.calls, 3, 'one IPP request per round, the core never asked');
  assert.equal(
    gladys.fake.lastState(`${device.external_id}:state`),
    'printing',
    'the change is published by the loop',
  );
  assert.ok(
    gladys.fake.requests.every((request) => !/poll/i.test(request.path)),
    'nothing went through the Gladys scheduler',
  );
  await gladys.disconnect();
});

test('onPoll is a fallback: skipped right after a loop sample, used when the loop is late', async () => {
  const { gladys, device, integration, ipp, clock, tick } = setup();
  await gladys.connect();
  await tick();
  assert.equal(ipp.calls, 2);

  const ack = await gladys.fake.poll(device);
  assert.equal(ack.success, true);
  assert.equal(ipp.calls, 2, 'no second IPP request a few seconds after the loop');

  // The loop stopped (or got stuck): the core's poll does the job.
  integration.stopRefreshLoop();
  clock.at += ON_POLL_SKIP_MS;
  assert.equal((await gladys.fake.poll(device)).success, true);
  assert.equal(ipp.calls, 3);
  await gladys.disconnect();
});

test('the loop is stopped on disconnection and re-armed on reconnection', async () => {
  const { gladys, integration } = setup();
  await gladys.connect();
  assert.equal(integration.isLoopArmed(), true);
  await gladys.disconnect();
  assert.equal(integration.isLoopArmed(), false);
  await gladys.connect();
  assert.equal(integration.isLoopArmed(), true);
  await gladys.disconnect();
});

test('a normal sampling cycle writes nothing in info', async (t) => {
  const { gladys, ipp, clock, tick } = setup();
  await gladys.connect();
  const lines = captureLogs(t);

  await tick(); // state unchanged, nothing published
  ipp.attributes = { ...COLOR_INKJET_ATTRIBUTES, 'printer-state': 4 };
  await tick(); // state change published
  clock.at += 900_000;
  await tick(); // levels due, published

  assert.deepEqual(lines.info, []);
  assert.deepEqual(lines.warn, []);
  await gladys.disconnect();
});

test('an unreachable printer logs once when it stops answering and once when it is back', async (t) => {
  const { gladys, ipp, tick } = setup();
  await gladys.connect();
  const lines = captureLogs(t);

  ipp.fail = new Error('connect EHOSTUNREACH 192.0.2.20:631');
  await tick();
  await tick();
  await tick();
  assert.equal(lines.warn.length, 1, lines.warn.join('\n'));
  assert.match(lines.warn[0], /does not answer/);

  ipp.fail = null;
  await tick();
  await tick();
  assert.equal(lines.info.length, 1, lines.info.join('\n'));
  assert.match(lines.info[0], /answers again/);
  assert.equal(lines.warn.length, 1);
  await gladys.disconnect();
});
