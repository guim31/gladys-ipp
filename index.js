// -----------------------------------------------------------------------------
// Entry point of the Gladys IPP printers integration.
//
// Role of this file: instantiate the SDK and start it. Every handler is
// registered by src/app.js (testable against the SDK fake Gladys); the IPP
// client lives in src/ipp/, the device mapping in src/device.js and the
// discovery in src/discovery.js.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// LOG_LEVEL=debug shows every sample, publication and IPP/SNMP exchange.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerIntegration } from './src/app.js';

const gladys = new GladysIntegration();

// Handlers are registered BEFORE connect().
const integration = registerIntegration(gladys);

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  integration.stopRefreshLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the IPP printers integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
