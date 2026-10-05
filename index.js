// -----------------------------------------------------------------------------
// Entry point of the Gladys IPP printers integration.
//
// Role of this file: wire the SDK to the printer logic (src/). It holds no
// protocol code — the IPP client lives in src/ipp/, the device mapping in
// src/device.js and the discovery in src/discovery.js. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, discovers the printers and publishes them.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { discoverPrinters } from './src/discovery.js';
import {
  buildPrinterDevice,
  buildPrinterStates,
  getPrinterSnapshot,
  isPrinterDevice,
  pollPrinter,
} from './src/device.js';
import { ACTIONS } from './src/actions.js';
import {
  WIDGET,
  PRINTER_ACTION,
  buildPrinterContent,
  buildSuppliesContent,
  printerSummary,
} from './src/widgets.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Own sampling loop over the devices the user created. Gladys also polls
// them (should_poll + poll_frequency), but re-publishing never updates the
// poll_frequency of an already-created device: this loop is the one cadence
// the integration fully controls, for every printer, old or new.
//
// It runs every STATE_SAMPLING_MS: a print job lasts seconds, so the state
// must be sampled often to be observed at all. pollPrinter only PUBLISHES
// on change (state) or on the configured interval (levels), so the frequent
// sampling costs one local IPP request and nothing else.
const STATE_SAMPLING_MS = 15_000;
let refreshTimer = null;

// Created printer devices, cached so the sampling loop does not hit
// GET /device every 15 s. Kept in sync by the device lifecycle events.
let printerDevices = [];

async function reloadPrinterDevices() {
  printerDevices = (await gladys.getDevices()).filter(isPrinterDevice);
  logger.debug(`Device cache: ${printerDevices.length} printer(s)`);
}

/**
 * Discover the printers (manual list + mDNS), publish them as devices and
 * push their current states right away — the user sees fresh ink levels
 * without waiting for the first poll cycle.
 * @returns {Promise<number>} number of printers published
 */
async function discoverAndPublish() {
  const { printers, errors } = await discoverPrinters(gladys, config);
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
      await gladys.publishStates(printers.flatMap((probed) => buildPrinterStates(gladys, probed)));
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
    try {
      const result = await pollPrinter(gladys, device, config, { force });
      refreshed += 1;
      changed = changed || result.stateChanged;
    } catch (err) {
      logger.error(`Refresh failed for ${device.external_id}: ${err.message}`);
    }
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
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startRefreshLoop() {
  stopRefreshLoop();
  logger.info(
    `Sampling loop every ${STATE_SAMPLING_MS / 1000}s ` +
      `(state published on change, levels every ${config.poll_frequency}s)`,
  );
  refreshTimer = setInterval(() => {
    refreshCreatedPrinters().catch((err) => logger.error('Sampling loop failed', err));
  }, STATE_SAMPLING_MS);
  // Never hold the process alive just for this timer.
  refreshTimer.unref?.();
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> discovering printers');
  await discoverAndPublish();
});

// --- The user just added one of the discovered printers ----------------------
// Publish its states immediately: the dashboard widget shows real values
// instead of "no recent value" until the first scheduled refresh.
gladys.onDeviceCreated(async (device) => {
  if (!isPrinterDevice(device)) {
    return;
  }
  logger.info(`onDeviceCreated -> first refresh of ${device.external_id}`);
  await pollPrinter(gladys, device, config, { force: true });
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

// --- Polling: Gladys asks to refresh a device --------------------------------
// The printer URL travels in the device params (PRINTER_URL), so polling
// works right after a restart, without a prior discovery.
gladys.onPoll(async (device) => {
  await pollPrinter(gladys, device, config);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const [actionKey, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
}

// --- Dashboard widgets (Gladys 5.1+) ------------------------------------------
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
  const device = printerDevices.find((candidate) => candidate.external_id === params?.printer);
  if (!device) {
    throw new Error(`Unknown printer: ${params?.printer}`);
  }
  await pollPrinter(gladys, device, config, { force: true });
  // The core reloads THIS widget when the action resolves; the supplies
  // widget shows the same reading and needs a nudge of its own.
  try {
    gladys.requestWidgetRefresh(WIDGET.SUPPLIES);
  } catch (err) {
    logger.debug(`Widget refresh not requested: ${err.message}`);
  }
  const snapshot = getPrinterSnapshot(device.external_id);
  return {
    en: `${device.name}: ${printerSummary(snapshot, 'en', config.feature_names).text}`,
    fr: `${device.name} : ${printerSummary(snapshot, 'fr', config.feature_names).text}`,
  };
});

// --- Configuration updated by the user ---------------------------------------
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

// --- Connection lifecycle ----------------------------------------------------
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
      count === 0
        ? {
            en: 'Connected — no printer found yet. Add one in the configuration or run a scan.',
            fr: 'Connecté — aucune imprimante trouvée pour le moment. Ajoutez-en une dans la configuration ou lancez un scan.',
          }
        : undefined,
    );
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  // Publishing states while disconnected is pointless: the loop is re-armed
  // by the 'connected' handler after every reconnection.
  stopRefreshLoop();
});

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the IPP printers integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
