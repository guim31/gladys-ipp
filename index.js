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
  isPrinterDevice,
  pollPrinter,
} from './src/device.js';
import { ACTIONS } from './src/actions.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Own refresh loop over the devices the user created. Gladys also polls them
// (should_poll + poll_frequency), but its scheduler only covers devices
// created WITH those fields: this loop keeps every printer refreshed at the
// configured interval, whatever the device record says.
let refreshTimer = null;

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
 * Query every printer the user actually created and publish its states.
 * @returns {Promise<number>} number of printers refreshed
 */
async function refreshCreatedPrinters() {
  const devices = (await gladys.getDevices()).filter(isPrinterDevice);
  if (devices.length === 0) {
    logger.debug('Refresh: no printer device created yet');
    return 0;
  }
  let refreshed = 0;
  for (const device of devices) {
    try {
      // force: this loop IS the schedule, it must not be throttled by the
      // interval check that protects the (more frequent) Gladys polls.
      await pollPrinter(gladys, device, config, { force: true });
      refreshed += 1;
    } catch (err) {
      logger.error(`Refresh failed for ${device.external_id}: ${err.message}`);
    }
  }
  return refreshed;
}

function stopRefreshLoop() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startRefreshLoop() {
  stopRefreshLoop();
  const intervalMs = Math.max(config.poll_frequency, 60) * 1000;
  logger.info(`Refresh loop every ${intervalMs / 1000}s`);
  refreshTimer = setInterval(() => {
    refreshCreatedPrinters().catch((err) => logger.error('Refresh loop failed', err));
  }, intervalMs);
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

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // Re-discover: the manual list or the poll frequency may have changed.
  // publishDiscoveredDevices is idempotent (upsert by external_id).
  await discoverAndPublish();
  // The interval may have changed: re-arm the loop on the new value.
  startRefreshLoop();
  await refreshCreatedPrinters();
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

    // 3) Refresh the printers the user already created, then keep them fresh
    // on the configured interval — independently of the Gladys scheduler.
    const refreshed = await refreshCreatedPrinters();
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
