// -----------------------------------------------------------------------------
// Wiring of the integration: registers every SDK handler on a Gladys client.
//
// index.js passes the real `new GladysIntegration()`; the tests pass the fake
// Gladys of the SDK (`@gladysassistant/integration-sdk/testing`) with stubbed
// IPP/SNMP access and timers. This file holds no protocol code — the IPP
// client lives in src/ipp/, the device mapping in src/device.js and the
// discovery in src/discovery.js.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { discoverPrinters } from './discovery.js';
import {
  buildPrinterDevice,
  buildPrinterStates,
  getPrinterSnapshot,
  isPrinterDevice,
  pollPrinter,
} from './device.js';
import { ACTIONS } from './actions.js';
import {
  WIDGET,
  PRINTER_ACTION,
  buildPrinterContent,
  buildSuppliesContent,
  printerSummary,
  LANGUAGES,
} from './widgets.js';
import { STATUS_TEXTS } from './status.js';

const logger = createLogger();

// Own sampling loop over the devices the user created. It is THE cadence of
// the integration, not a complement to the Gladys scheduler: Gladys 5.2.0
// only polls a device created with should_poll AND a valid poll_frequency,
// re-publishing never updates those two fields on a device already created
// (GladysAssistant/Gladys#3198), and printers created by an older version
// may lack them. Every created printer is sampled here, old or new.
//
// A print job lasts seconds, so the state must be sampled often to be
// observed at all. pollPrinter only PUBLISHES on change (state) or on the
// configured interval (levels): a sample costs one local IPP request.
export const STATE_SAMPLING_MS = 15_000;

// onPoll stays as a fallback (the loop not armed yet, a stuck loop): it
// skips a printer the loop sampled less than this long ago, so the Gladys
// scheduler never doubles the IPP requests of a healthy loop.
export const ON_POLL_SKIP_MS = 2 * STATE_SAMPLING_MS;

/**
 * Register the handlers of the integration on a Gladys client.
 * @param {object} gladys GladysIntegration, or the SDK fake in tests
 * @param {{ pollDeps?: object, discoveryDeps?: object, now?: () => number,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [deps]
 *   test seams: `pollDeps` / `discoveryDeps` go to pollPrinter / discoverPrinters
 * @returns {{ stopRefreshLoop: () => void, isLoopArmed: () => boolean }}
 */
export function registerIntegration(gladys, deps = {}) {
  const {
    pollDeps = {},
    discoveryDeps = {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = deps;

  // Current configuration (hot-reloaded via onConfigUpdated).
  let config = normalizeConfig();

  // Created printer devices, cached so the sampling loop does not hit
  // GET /device every 15 s. Kept in sync by the device lifecycle events.
  let printerDevices = [];

  // Self-scheduling loop: the next round is armed once the previous one
  // settled, so a few unreachable printers (10 s timeout each) never make
  // two rounds overlap. `loopGeneration` drops a round that finishes after
  // the loop was stopped or restarted.
  let refreshTimer = null;
  let loopGeneration = 0;

  // When each printer was last sampled (success or failure), for onPoll.
  const lastSampleAt = new Map();

  // Printers whose last sample failed: one warning when a printer stops
  // answering, one line when it is back, nothing in between (a printer
  // switched off at night would otherwise log every 15 s).
  const unreachable = new Set();

  async function reloadPrinterDevices() {
    printerDevices = (await gladys.getDevices()).filter(isPrinterDevice);
    logger.debug(`Device cache: ${printerDevices.length} printer(s)`);
  }

  /**
   * Sample one printer through pollPrinter, with the failure deduplication.
   * Never throws: a failure is logged (once) and reported in the result.
   * @returns {Promise<{ ok: boolean, stateChanged: boolean }>}
   */
  async function sampleDevice(device, { force = false } = {}) {
    lastSampleAt.set(device.external_id, now());
    try {
      const result = await pollPrinter(gladys, device, config, { ...pollDeps, force });
      if (unreachable.delete(device.external_id)) {
        logger.info(`${device.name ?? device.external_id} answers again`);
      }
      return { ok: true, stateChanged: result.stateChanged };
    } catch (err) {
      if (unreachable.has(device.external_id)) {
        logger.debug(`Still no answer from ${device.external_id}: ${err.message}`);
      } else {
        unreachable.add(device.external_id);
        logger.warn(
          `${device.name ?? device.external_id} does not answer (${err.message}); ` +
            'retrying silently until it is back',
        );
      }
      return { ok: false, stateChanged: false };
    }
  }

  /**
   * Discover the printers (manual list + mDNS), publish them as devices and
   * push their current states right away — the user sees fresh ink levels
   * without waiting for the first poll cycle.
   * @returns {Promise<number>} number of printers published
   */
  async function discoverAndPublish() {
    const { printers, errors } = await discoverPrinters(gladys, config, discoveryDeps);
    if (printers.length > 0) {
      const devices = printers.map((probed) => buildPrinterDevice(gladys, probed, config));
      try {
        await gladys.publishDiscoveredDevices(devices);
        logger.info(`Published ${devices.length} discovered device(s)`);
      } catch (err) {
        // Surface the host API refusal in clear text: this is THE line to look
        // for when the Discovery screen stays empty.
        logger.error(`publishDiscoveredDevices refused by Gladys: ${err.message}`);
        logger.debug(`Refused payload: ${JSON.stringify(devices)}`);
        throw err;
      }
      try {
        // Fresh states right away, so added devices show values without waiting
        // for the first poll. Gladys may refuse states for devices the user has
        // not added yet: that must not fail the discovery itself.
        await gladys.publishStates(
          printers.flatMap((probed) => buildPrinterStates(gladys, probed)),
        );
      } catch (err) {
        logger.warn(`Initial states refused (devices not added yet?): ${err.message}`);
      }
    }
    logger.info(`Discovery done: ${printers.length} printer(s), ${errors.length} target(s) failed`);
    return printers.length;
  }

  /**
   * Sample every cached printer once. pollPrinter decides what (if anything)
   * gets published: state on change, levels on their interval, everything
   * when `force` is set (reconnection).
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<number>} number of printers sampled without error
   */
  async function refreshCreatedPrinters({ force = false } = {}) {
    if (printerDevices.length === 0) {
      logger.debug('Refresh: no printer device created yet');
      return 0;
    }
    let refreshed = 0;
    let changed = false;
    for (const device of printerDevices) {
      const result = await sampleDevice(device, { force });
      refreshed += result.ok ? 1 : 0;
      changed = changed || result.stateChanged;
    }
    if (changed) {
      // The gauges are bound to the level features and follow the states on
      // their own; the state rows and the supplies list are cached by the
      // core until ttl_seconds: a change of state is worth a nudge.
      nudgeWidgets();
    }
    return refreshed;
  }

  /**
   * Ask the core to re-pull both widgets now. Fire-and-forget, rate-limited
   * core-side (1 per 10 s per widget) and dropped while disconnected: never
   * worth failing a poll for.
   */
  function nudgeWidgets() {
    for (const key of Object.values(WIDGET)) {
      try {
        gladys.requestWidgetRefresh(key);
      } catch (err) {
        logger.debug(`Widget refresh not requested for ${key}: ${err.message}`);
      }
    }
  }

  function stopRefreshLoop() {
    loopGeneration += 1;
    if (refreshTimer !== null) {
      clearTimer(refreshTimer);
      refreshTimer = null;
    }
  }

  function scheduleNextRound(generation) {
    refreshTimer = setTimer(async () => {
      refreshTimer = null;
      try {
        await refreshCreatedPrinters();
      } catch (err) {
        logger.error('Sampling loop failed', err);
      }
      if (generation === loopGeneration) {
        scheduleNextRound(generation);
      }
    }, STATE_SAMPLING_MS);
    // Never hold the process alive just for this timer.
    refreshTimer?.unref?.();
  }

  function startRefreshLoop() {
    stopRefreshLoop();
    logger.info(
      `Sampling loop every ${STATE_SAMPLING_MS / 1000}s ` +
        `(state published on change, levels every ${config.poll_frequency}s)`,
    );
    scheduleNextRound(loopGeneration);
  }

  // --- Discovery: Gladys asks for the list of devices ------------------------
  gladys.onScanRequest(async () => {
    logger.info('onScanRequest -> discovering printers');
    await discoverAndPublish();
  });

  // --- The user just added one of the discovered printers --------------------
  // Publish its states immediately: the dashboard widget shows real values
  // instead of "no recent value" until the first scheduled refresh.
  gladys.onDeviceCreated(async (device) => {
    if (!isPrinterDevice(device)) {
      return;
    }
    logger.info(`onDeviceCreated -> first refresh of ${device.external_id}`);
    await sampleDevice(device, { force: true });
    await reloadPrinterDevices();
    nudgeWidgets();
  });

  // Keep the sampling-loop cache honest when devices change outside our flow.
  gladys.onDeviceUpdated(async () => {
    await reloadPrinterDevices();
  });
  gladys.onDeviceDeleted(async () => {
    await reloadPrinterDevices();
  });

  // --- Polling: fallback only, see STATE_SAMPLING_MS --------------------------
  // The printer URL travels in the device params (PRINTER_URL), so polling
  // works right after a restart, without a prior discovery.
  gladys.onPoll(async (device) => {
    const last = lastSampleAt.get(device.external_id);
    if (last !== undefined && now() - last < ON_POLL_SKIP_MS) {
      logger.debug(`onPoll ${device.external_id}: sampled ${now() - last} ms ago, skipped`);
      return;
    }
    await sampleDevice(device);
  });

  // --- Manifest actions: buttons in the Configuration screen -----------------
  for (const [actionKey, handler] of Object.entries(ACTIONS)) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
  }

  // --- Dashboard widgets (Gladys 5.1+) ----------------------------------------
  // The content is built from the device cache and the last answer of each
  // printer kept by pollPrinter: rendering never queries a printer.

  /**
   * The created printers, for the widgets. The cache is normally warm; an
   * empty one is re-read once (the core may ask for a widget before the
   * post-connection initialization filled it).
   * @returns {Promise<object[]>}
   */
  async function widgetPrinters() {
    if (printerDevices.length === 0) {
      await reloadPrinterDevices().catch((err) => {
        logger.warn(`Device cache not refreshed for the widget: ${err.message}`);
      });
    }
    return printerDevices;
  }

  gladys.onWidgetGet(WIDGET.PRINTER, async ({ settings, language }) => {
    const devices = await widgetPrinters();
    const wanted = typeof settings?.printer === 'string' && settings.printer !== '';
    const device = wanted
      ? devices.find((candidate) => candidate.external_id === settings.printer)
      : devices[0];
    return buildPrinterContent({
      device: device ?? null,
      snapshot: device ? getPrinterSnapshot(device.external_id) : undefined,
      language,
      featureNames: config.feature_names,
      missing: wanted && !device && devices.length > 0,
    });
  });

  gladys.onWidgetGet(WIDGET.SUPPLIES, async ({ language }) => {
    const devices = await widgetPrinters();
    return buildSuppliesContent({
      printers: devices.map((device) => ({
        device,
        snapshot: getPrinterSnapshot(device.external_id),
      })),
      language,
      featureNames: config.feature_names,
    });
  });

  // "Check": query this printer now and publish everything. The core reloads
  // the widget as soon as the action resolves; the toast sums up the answer.
  gladys.onWidgetAction(WIDGET.PRINTER, async (actionKey, params) => {
    if (actionKey !== PRINTER_ACTION.CHECK) {
      throw new Error(`Unknown widget action: ${actionKey}`);
    }
    // Through widgetPrinters(): a tap right after a restart must not fail on
    // a device cache the initialization has not filled yet.
    const devices = await widgetPrinters();
    const device = devices.find((candidate) => candidate.external_id === params?.printer);
    if (!device) {
      throw new Error(`Unknown printer: ${params?.printer}`);
    }
    // The user asked: the error goes back to the toast, not to the silent
    // retry bookkeeping of the loop.
    await pollPrinter(gladys, device, config, { ...pollDeps, force: true });
    // The core reloads THIS widget when the action resolves; the supplies
    // widget shows the same reading and needs a nudge of its own.
    try {
      gladys.requestWidgetRefresh(WIDGET.SUPPLIES);
    } catch (err) {
      logger.debug(`Widget refresh not requested: ${err.message}`);
    }
    const snapshot = getPrinterSnapshot(device.external_id);
    return Object.fromEntries(
      LANGUAGES.map((lang) => [
        lang,
        `${device.name}${lang === 'fr' ? ' :' : ':'} ${printerSummary(snapshot, lang, config.feature_names).text}`,
      ]),
    );
  });

  // --- Configuration updated by the user -------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    config = normalizeConfig(newConfig);
    // Re-discover: the manual list or the poll frequency may have changed.
    // publishDiscoveredDevices is idempotent (upsert by external_id).
    await discoverAndPublish();
    await reloadPrinterDevices();
    startRefreshLoop();
    await refreshCreatedPrinters({ force: true });
  });

  // --- Connection lifecycle --------------------------------------------------
  // The SDK itself logs the WebSocket lifecycle (connections, disconnections,
  // reconnection attempts) under the `gladys-sdk` name: these handlers only run
  // the integration's own (re)initialization.
  gladys.on('connected', async () => {
    try {
      // 1) Fetch the config filled in by the user.
      config = normalizeConfig(await gladys.getConfig());

      // 2) Discover and publish the printers as soon as we are connected.
      const count = await discoverAndPublish();

      // 3) Refresh the printers the user already created (everything, now),
      // then keep sampling them — independently of the Gladys scheduler.
      await reloadPrinterDevices();
      const refreshed = await refreshCreatedPrinters({ force: true });
      logger.info(`Refreshed ${refreshed} created printer(s) on connection`);
      startRefreshLoop();

      // 4) Report the application-level status, shown in the Configuration
      // screen. Zero printer is not an error (the user may not have configured
      // anything yet): stay connected and let the docs guide them.
      await gladys.setConnectionStatus(
        true,
        count === 0 ? { ...STATUS_TEXTS.noPrinter } : undefined,
      );
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys.setConnectionStatus(false, { ...STATUS_TEXTS.initFailed }).catch(() => {});
    }
  });

  gladys.on('disconnected', () => {
    // Publishing states while disconnected is pointless: the loop is re-armed
    // by the 'connected' handler after every reconnection.
    stopRefreshLoop();
  });

  return {
    stopRefreshLoop,
    isLoopArmed: () => refreshTimer !== null,
  };
}
