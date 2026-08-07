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
import { postIpp } from './transport.js';

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

// Request variants, tried in order until one works. Standards-compliant
// printers accept the first; the others cover the classic quirks of
// minimalist firmwares (Epson EcoTank and friends): some require IPP 2.0,
// some answer HTTP 500 to an explicit requested-attributes list.
const REQUEST_VARIANTS = [
  { version: [1, 1], requestedAttributes: REQUESTED_ATTRIBUTES, label: 'ipp1.1' },
  { version: [2, 0], requestedAttributes: REQUESTED_ATTRIBUTES, label: 'ipp2.0' },
  { version: [2, 0], requestedAttributes: null, label: 'ipp2.0-all' },
];

// Variant index that worked last, per URL: a printer needing IPP 2.0 costs
// one failed 1.1 request on the FIRST query only, not on every poll.
const workingVariant = new Map();

/** Reset the variant cache (tests only). */
export function resetVariantCache() {
  workingVariant.clear();
}

/**
 * Send one Get-Printer-Attributes request with a specific variant.
 * @param {string} url
 * @param {{ version: [number, number], requestedAttributes: string[]|null }} variant
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
async function requestWithVariant(url, variant, timeoutMs) {
  const body = encodeGetPrinterAttributes(toIppUri(url), variant.requestedAttributes, 1, {
    version: variant.version,
  });
  const { status, body: responseBody } = await postIpp(url, body, timeoutMs);
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} from ${url}`);
  }
  const message = decodeMessage(responseBody);
  if (message.statusCode > STATUS.SUCCESSFUL_OK_MAX) {
    throw new Error(`IPP status 0x${message.statusCode.toString(16).padStart(4, '0')} from ${url}`);
  }
  return printerAttributes(message);
}

/**
 * Send a Get-Printer-Attributes request and return the printer attributes.
 * Tries the request variants in order (starting with the one that worked
 * last for this URL) until one succeeds.
 * @param {string} url HTTP URL of the IPP endpoint
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getPrinterAttributes(url, options = {}) {
  const { timeoutMs = 10_000 } = options;
  const known = workingVariant.get(url);
  const order =
    known === undefined
      ? REQUEST_VARIANTS.map((_, i) => i)
      : [known, ...REQUEST_VARIANTS.map((_, i) => i).filter((i) => i !== known)];

  let lastError = null;
  for (const index of order) {
    const variant = REQUEST_VARIANTS[index];
    try {
      logger.debug(`Get-Printer-Attributes (${variant.label}) -> ${url}`);
      const attributes = await requestWithVariant(url, variant, timeoutMs);
      workingVariant.set(url, index);
      if (index !== 0) {
        logger.info(`${url} answered with the ${variant.label} compatibility variant`);
      }
      return attributes;
    } catch (err) {
      logger.debug(`Variant ${variant.label} failed on ${url}: ${err.message}`);
      lastError = err;
      // A network-level failure (no HTTP answer at all) will fail identically
      // for every variant: stop here instead of hammering a dead host. Same
      // for HTTP 426 (Upgrade Required): it is about the TRANSPORT — the
      // printer wants TLS — not about the request shape.
      if (!/^(HTTP|IPP status)/.test(err.message) || /^HTTP 426 /.test(err.message)) {
        break;
      }
    }
  }
  throw lastError;
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
  const queue = candidateUrls(target);
  if (queue.length === 0) {
    throw new Error('Empty printer target');
  }
  const tried = new Set();
  let lastError = null;
  while (queue.length > 0) {
    const url = queue.shift();
    if (tried.has(url)) {
      continue;
    }
    tried.add(url);
    try {
      const attributes = await fetchAttributes(url, { timeoutMs });
      return { url, attributes };
    } catch (err) {
      logger.debug(`Probe failed on ${url}: ${err.message}`);
      lastError = err;
      // HTTP 426 Upgrade Required: the printer only accepts encrypted IPP on
      // this endpoint (Epson EcoTank...). Try the https twin of the SAME
      // path first — that is exactly what the 426 asks for.
      if (/HTTP 426 /.test(err.message) && url.startsWith('http://')) {
        queue.unshift(`https://${url.slice('http://'.length)}`);
      }
    }
  }
  throw new Error(`Printer "${target}" unreachable over IPP (${lastError?.message})`);
}
