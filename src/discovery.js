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
import { withFallbackSupplies } from './supplies.js';
import { platformIdFor } from './device.js';

const logger = createLogger({ name: 'discovery' });

/**
 * Is this mDNS entry really an `_ipp._tcp` printer service?
 *
 * The Gladys core mDNS scan aggregates every SRV record found in the
 * responses, and only filters PTR records by service type. Chatty hosts
 * (NAS, box, Home Assistant, Matter devices...) pack the SRV records of
 * their OTHER services (_ssh._tcp:22, _ftp._tcp:21, _smb._tcp:445...) in the
 * additionals of an _ipp._tcp answer, so those leak in as fake "printers".
 * Probing them would turn discovery into a port scan — refuse anything whose
 * instance name is not an _ipp._tcp service.
 * @param {{ name?: string }} entry
 * @returns {boolean}
 */
export function isIppServiceEntry(entry) {
  return typeof entry?.name === 'string' && /\._ipp\._tcp\b/i.test(entry.name);
}

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
 * @param {{ probe?: typeof probePrinter, scanTimeoutSeconds?: number,
 *           fallbackSupplies?: typeof withFallbackSupplies }} [deps] test seam
 * @returns {Promise<{ printers: Array<{ printer: object, url: string, target: string }>,
 *                     errors: Array<{ target: string, error: Error }> }>}
 */
export async function discoverPrinters(gladys, config, deps = {}) {
  const {
    probe = probePrinter,
    scanTimeoutSeconds = 5,
    fallbackSupplies = withFallbackSupplies,
  } = deps;

  const targets = parsePrinterHosts(config.printer_hosts);

  let mdnsEntries = [];
  try {
    const scanned = await gladys.scanNetwork('mdns', { timeoutSeconds: scanTimeoutSeconds });
    // Be defensive about the response shape: a scan must NEVER prevent the
    // manual list from being probed.
    const raw = Array.isArray(scanned) ? scanned : (scanned?.results ?? []);
    if (!Array.isArray(raw)) {
      logger.warn(`mDNS scan returned an unexpected shape (${typeof scanned}), ignoring it`);
    } else {
      // The core mixes non-printer SRV records into the results: keep only the
      // genuine _ipp._tcp instances, or discovery would probe every service on
      // the LAN (SSH, SMB, Home Assistant...) on its own port.
      mdnsEntries = raw.filter(isIppServiceEntry);
      const dropped = raw.length - mdnsEntries.length;
      logger.info(
        `mDNS scan: ${mdnsEntries.length} printer service(s)` +
          (dropped > 0 ? ` (${dropped} non-printer mDNS entries ignored)` : ''),
      );
    }
  } catch (err) {
    logger.warn(`mDNS scan unavailable (${err.message}), using the manual list only`);
  }
  for (const entry of mdnsEntries) {
    try {
      const url = mdnsCandidateUrl(entry);
      if (url && !targets.includes(url)) {
        targets.push(url);
      }
    } catch (err) {
      logger.warn(`Ignoring malformed mDNS entry (${err.message})`);
    }
  }

  const printers = [];
  const errors = [];
  const seenIds = new Set();
  for (const target of targets) {
    try {
      const { url, attributes } = await probe(target);
      // A printer announcing no supply over IPP gets one SNMP chance here, so
      // its cartridges exist as features from the very first discovery.
      const printer = await fallbackSupplies(parsePrinter(attributes), url);
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
