// -----------------------------------------------------------------------------
// HTTP(S) transport for the IPP requests.
//
// Built on node:http / node:https instead of fetch for ONE reason: printers
// requiring encrypted IPP (HTTP 426 -> ipps://) present self-signed
// certificates, which fetch rejects with no per-request escape hatch.
// Certificate verification is disabled for these LOCAL printer endpoints
// only: the data is read-only supply levels on the LAN, and strict
// verification would simply refuse every ipps-only printer ever made.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * POST an IPP payload and resolve with the raw response.
 * @param {string} url HTTP or HTTPS URL of the IPP endpoint
 * @param {Buffer} body encoded IPP request
 * @param {number} timeoutMs socket timeout
 * @returns {Promise<{ status: number, body: Buffer }>}
 */
export function postIpp(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/ipp',
          'user-agent': 'gladys-ipp',
          'content-length': body.length,
        },
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
