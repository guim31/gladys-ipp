// -----------------------------------------------------------------------------
// Printer discovery: manual list (config) + mDNS (mediated by the Gladys core).
//
// Integration containers cannot see LAN mDNS traffic themselves: the core
// captures `_ipp._tcp` (declared in the manifest `network_discovery` field)
// and returns the raw service instances; joining each printer in unicast —
// the IPP probe — is done here.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { probePrinter } from './ipp/client.js';
import { parsePrinterHosts } from './config.js';
import { parsePrinter } from './printer.js';
import { platformIdFor } from './device.js';

const logger = createLogger({ name: 'discovery' });

/**
 * Build the candidate URL of an mDNS `_ipp._tcp` service instance.
 * The TXT record `rp` carries the resource path (e.g. 'ipp/print').
 * @param {{ host: string, addresses?: string[], port?: number, txt?: Record<string, string> }} entry
 * @returns {string|null}
 */
export function mdnsCandidateUrl(entry) {
  const address = entry.addresses?.find((a) => a && !a.includes(':')) ?? entry.host;
  if (!address) {
    return null;
  }
  const port = entry.port || 631;
  const txt = entry.txt ?? {};
  const rp = String(txt.rp ?? txt.RP ?? 'ipp/print').replace(/^\/+/, '');
  return `http://${address}:${port}/${rp}`;
}

/**
 * Discover all reachable printers: probe the manual targets and the mDNS
 * service instances, parse their attributes, dedupe by platform id.
 * mDNS failures are non-fatal (older Gladys, no mediated discovery...):
 * the manual list keeps working.
 * @param {object} gladys SDK instance
 * @param {{ printer_hosts: string }} config
 * @param {{ probe?: typeof probePrinter, scanTimeoutSeconds?: number }} [deps] test seam
 * @returns {Promise<{ printers: Array<{ printer: object, url: string, target: string }>,
 *                     errors: Array<{ target: string, error: Error }> }>}
 */
export async function discoverPrinters(gladys, config, deps = {}) {
  const { probe = probePrinter, scanTimeoutSeconds = 5 } = deps;

  const targets = parsePrinterHosts(config.printer_hosts);

  let mdnsEntries = [];
  try {
    mdnsEntries = await gladys.scanNetwork('mdns', { timeoutSeconds: scanTimeoutSeconds });
    logger.info(`mDNS scan: ${mdnsEntries.length} _ipp._tcp service(s) seen`);
  } catch (err) {
    logger.warn(`mDNS scan unavailable (${err.message}), using the manual list only`);
  }
  for (const entry of mdnsEntries) {
    const url = mdnsCandidateUrl(entry);
    if (url && !targets.includes(url)) {
      targets.push(url);
    }
  }

  const printers = [];
  const errors = [];
  const seenIds = new Set();
  for (const target of targets) {
    try {
      const { url, attributes } = await probe(target);
      const printer = parsePrinter(attributes);
      const platformId = platformIdFor(printer, url);
      if (seenIds.has(platformId)) {
        continue; // same printer reached through two targets (manual + mDNS)
      }
      seenIds.add(platformId);
      printers.push({ printer, url, target });
      logger.info(`Found printer "${printer.makeAndModel ?? printer.name ?? url}" at ${url}`);
    } catch (err) {
      errors.push({ target, error: err });
      logger.warn(`Target "${target}" skipped: ${err.message}`);
    }
  }
  return { printers, errors };
}
