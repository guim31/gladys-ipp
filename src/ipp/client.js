// -----------------------------------------------------------------------------
// IPP HTTP client: talk to a printer on the LAN.
//
// An IPP request is an HTTP POST of the binary message (content-type
// application/ipp), usually on port 631. The printer URI must ALSO appear
// inside the message, with the ipp:// scheme.
//
// Node 20+ provides `fetch` natively: no dependency needed.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { STATUS } from './constants.js';
import { decodeMessage, encodeGetPrinterAttributes, printerAttributes } from './message.js';

const logger = createLogger({ name: 'ipp-client' });

export const DEFAULT_IPP_PORT = 631;

// Resource paths tried in order when the user only gives a host/IP.
// '/ipp/print' is the AirPrint/everywhere standard, the other two cover
// older firmwares (many just accept any path).
const DEFAULT_PATHS = ['/ipp/print', '/ipp', '/'];

// The attributes the integration cares about. 'all' would work too, but a
// precise list keeps the answers small and avoids exotic values.
export const REQUESTED_ATTRIBUTES = [
  'printer-name',
  'printer-make-and-model',
  'printer-location',
  'printer-uuid',
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'marker-names',
  'marker-levels',
  'marker-colors',
  'marker-types',
  'marker-high-levels',
  'marker-low-levels',
];

/**
 * Build the list of candidate HTTP URLs for a user-supplied target.
 * Accepted forms: '192.168.1.20', 'printer.local:631', 'ipp://host/ipp/print',
 * 'ipps://host/ipp/print', 'http(s)://host:631/path'.
 * @param {string} target
 * @returns {string[]} HTTP URLs to try, in order
 */
export function candidateUrls(target) {
  const trimmed = String(target ?? '').trim();
  if (trimmed === '') {
    return [];
  }
  if (/^ipps?:\/\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed.replace(/^ipps:/i, 'https:').replace(/^ipp:/i, 'http:'));
    if (url.port === '') {
      url.port = String(DEFAULT_IPP_PORT);
    }
    // An explicit path: trust it. No path: try the default ones.
    if (url.pathname === '/') {
      return DEFAULT_PATHS.map((path) => new URL(path, url).toString());
    }
    return [url.toString()];
  }
  // Bare host (optionally with :port).
  const [host, port] = trimmed.split(':');
  const base = `http://${host}:${port ?? DEFAULT_IPP_PORT}`;
  return DEFAULT_PATHS.map((path) => `${base}${path}`);
}

/**
 * Derive the ipp:// URI (which goes INSIDE the IPP message) from the HTTP URL
 * the request is POSTed to.
 * @param {string} httpUrl
 * @returns {string}
 */
export function toIppUri(httpUrl) {
  const url = new URL(httpUrl);
  const scheme = url.protocol === 'https:' ? 'ipps' : 'ipp';
  // new URL() blanks a default port (http://x:80, https://x:443): reflect the
  // port the transport will actually use, not the IPP default.
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? 443 : 80;
  return `${scheme}://${url.hostname}:${port}${url.pathname}`;
}

/**
 * Send a Get-Printer-Attributes request and return the printer attributes.
 * @param {string} url HTTP URL of the IPP endpoint
 * @param {{ timeoutMs?: number, requestedAttributes?: string[] }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getPrinterAttributes(url, options = {}) {
  const { timeoutMs = 10_000, requestedAttributes = REQUESTED_ATTRIBUTES } = options;
  const body = encodeGetPrinterAttributes(toIppUri(url), requestedAttributes);

  logger.debug(`Get-Printer-Attributes -> ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/ipp' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  const message = decodeMessage(Buffer.from(await response.arrayBuffer()));
  if (message.statusCode > STATUS.SUCCESSFUL_OK_MAX) {
    throw new Error(`IPP status 0x${message.statusCode.toString(16).padStart(4, '0')} from ${url}`);
  }
  return printerAttributes(message);
}

/**
 * Probe a target: try every candidate URL until one answers a valid IPP
 * response. Resolves with the working URL and the printer attributes.
 * @param {string} target host, IP or URI as typed by the user (or found by mDNS)
 * @param {{ timeoutMs?: number, fetchAttributes?: typeof getPrinterAttributes }} [options]
 * @returns {Promise<{ url: string, attributes: Record<string, unknown> }>}
 */
export async function probePrinter(target, options = {}) {
  const { fetchAttributes = getPrinterAttributes, timeoutMs } = options;
  const urls = candidateUrls(target);
  if (urls.length === 0) {
    throw new Error('Empty printer target');
  }
  let lastError = null;
  for (const url of urls) {
    try {
      const attributes = await fetchAttributes(url, { timeoutMs });
      return { url, attributes };
    } catch (err) {
      logger.debug(`Probe failed on ${url}: ${err.message}`);
      lastError = err;
    }
  }
  throw new Error(`Printer "${target}" unreachable over IPP (${lastError?.message})`);
}
