// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys from the `config_schema` declared in
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  // Manual printer list: hosts, IPs or ipp:// URIs, separated by commas,
  // semicolons or newlines. Optional: mDNS discovery also finds printers.
  printer_hosts: '',
  // Seconds between two recordings of the ink/toner levels.
  poll_frequency: 900,
  // Language of the feature names: 'printer' keeps the raw names reported by
  // the printer, 'fr'/'en' translate the recognized supplies.
  feature_names: 'printer',
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const pollFrequency = Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    printer_hosts: String(raw.printer_hosts ?? DEFAULT_CONFIG.printer_hosts),
    poll_frequency: Number.isFinite(pollFrequency) ? pollFrequency : DEFAULT_CONFIG.poll_frequency,
    feature_names: ['printer', 'fr', 'en'].includes(raw.feature_names)
      ? raw.feature_names
      : DEFAULT_CONFIG.feature_names,
  };
}

/**
 * Split the manual printer list into individual targets.
 * @param {string} printerHosts raw config value
 * @returns {string[]} deduplicated, in the user's order
 */
export function parsePrinterHosts(printerHosts) {
  const targets = String(printerHosts ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return [...new Set(targets)];
}
