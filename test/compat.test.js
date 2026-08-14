// -----------------------------------------------------------------------------
// IPP compatibility cascade, exercised against a real local HTTP server that
// mimics a minimalist firmware (Epson EcoTank style): HTTP 500 on IPP 1.1,
// success on IPP 2.0.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { TAGS } from '../src/ipp/constants.js';
import { getPrinterAttributes, probePrinter, resetVariantCache } from '../src/ipp/client.js';
import { decodeMessage, encodeGetPrinterAttributes } from '../src/ipp/message.js';
import { attr, buildIppResponse, colorInkjetResponse } from './helpers/ippFixtures.js';

const TLS_FIXTURE = {
  key: readFileSync(new URL('./helpers/fixtures/localhost-key.pem', import.meta.url)),
  cert: readFileSync(new URL('./helpers/fixtures/localhost-cert.pem', import.meta.url)),
};

// --- request encoding --------------------------------------------------------

test('the request always carries requesting-user-name', () => {
  const message = decodeMessage(encodeGetPrinterAttributes('ipp://x:631/ipp/print', ['a']));
  assert.equal(message.groups[0].attributes['requesting-user-name'], 'gladys-ipp');
});

test('the IPP version is configurable', () => {
  const message = decodeMessage(
    encodeGetPrinterAttributes('ipp://x:631/ipp/print', ['a'], 1, { version: [2, 0] }),
  );
  assert.equal(message.version, '2.0');
});

test('a null requested-attributes list omits the attribute (server default: all)', () => {
  const message = decodeMessage(encodeGetPrinterAttributes('ipp://x:631/ipp/print', null));
  assert.equal(message.groups[0].attributes['requested-attributes'], undefined);
});

// --- variant cascade against a fake EcoTank ----------------------------------

function startFakeEcoTank() {
  // Accepts only IPP 2.0 requests, answers HTTP 500 otherwise — the exact
  // symptom reported on the ET-2815.
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const message = decodeMessage(Buffer.concat(chunks));
      requests.push(message.version);
      if (message.version !== '2.0') {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/ipp' }).end(colorInkjetResponse());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}/ipp/print` });
    });
  });
}

test('getPrinterAttributes falls back to IPP 2.0 and remembers the variant', async () => {
  resetVariantCache();
  const { server, requests, url } = await startFakeEcoTank();
  try {
    const attributes = await getPrinterAttributes(url);
    assert.equal(attributes['printer-make-and-model'], 'HP OfficeJet Pro 9010');
    assert.deepEqual(requests, ['1.1', '2.0'], 'first query: 1.1 refused, then 2.0 accepted');

    requests.length = 0;
    await getPrinterAttributes(url);
    assert.deepEqual(requests, ['2.0'], 'the working variant must be remembered per URL');
  } finally {
    server.close();
  }
});

// --- supply sweep (markers only without requested-attributes) ----------------

function startFakeEt2810({ suppliesWhenUnrequested = true } = {}) {
  // Answers every request cleanly, but omits the marker-* attributes when the
  // request carries an explicit requested-attributes list — the ET-2810
  // symptom: discovered fine, state fine, zero cartridges.
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const message = decodeMessage(Buffer.concat(chunks));
      const requested = message.groups[0].attributes['requested-attributes'];
      requests.push(requested === undefined ? 'all' : 'list');
      const body =
        requested === undefined && suppliesWhenUnrequested
          ? colorInkjetResponse()
          : buildIppResponse({
              printerAttrs: [
                attr('printer-name', [{ tag: TAGS.NAME_WITHOUT_LANGUAGE, value: 'EPSON ET-2810' }]),
                attr('printer-state', [{ tag: TAGS.ENUM, value: 3 }]),
              ],
            });
      res.writeHead(200, { 'content-type': 'application/ipp' }).end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}/ipp/print` });
    });
  });
}

test('getPrinterAttributes keeps trying variants when the answer lacks supplies', async () => {
  resetVariantCache();
  const { server, requests, url } = await startFakeEt2810();
  try {
    const attributes = await getPrinterAttributes(url);
    assert.deepEqual(attributes['marker-levels'], [42, 71, 18, 93]);
    assert.deepEqual(
      requests,
      ['list', 'list', 'all'],
      'both explicit-list variants answered without supplies: the all variant must be tried',
    );

    requests.length = 0;
    await getPrinterAttributes(url);
    assert.deepEqual(requests, ['all'], 'the supply-bearing variant must be remembered per URL');
  } finally {
    server.close();
  }
});

test('getPrinterAttributes sweeps a supply-less printer once, then polls with one request', async () => {
  resetVariantCache();
  const { server, requests, url } = await startFakeEt2810({ suppliesWhenUnrequested: false });
  try {
    const attributes = await getPrinterAttributes(url);
    assert.equal(attributes['printer-name'], 'EPSON ET-2810');
    assert.equal(attributes['printer-state'], 3);
    assert.equal(attributes['marker-levels'], undefined);
    assert.equal(requests.length, 3, 'every variant is tried once looking for supplies');

    requests.length = 0;
    await getPrinterAttributes(url);
    assert.deepEqual(requests, ['list'], 'no supplies anywhere: later polls must not re-sweep');
  } finally {
    server.close();
  }
});

// --- encrypted IPP (HTTP 426 -> ipps) ----------------------------------------

test('getPrinterAttributes accepts a self-signed TLS printer (ipps)', async () => {
  resetVariantCache();
  // Printers requiring encrypted IPP present self-signed certificates: the
  // transport must accept them or every ipps-only printer is unreachable.
  const server = createHttpsServer(TLS_FIXTURE, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/ipp' }).end(colorInkjetResponse());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const attributes = await getPrinterAttributes(`https://127.0.0.1:${port}/ipp/print`);
    assert.equal(attributes['printer-make-and-model'], 'HP OfficeJet Pro 9010');
  } finally {
    server.close();
  }
});

test('probePrinter answers HTTP 426 by trying the https twin of the same path', async () => {
  const tried = [];
  const fetchAttributes = async (url) => {
    tried.push(url);
    if (url === 'https://192.168.1.51:631/ipp/print') {
      return { 'printer-state': 3 };
    }
    throw new Error(`HTTP 426 from ${url}`);
  };
  const { url } = await probePrinter('192.168.1.51', { fetchAttributes });
  assert.equal(url, 'https://192.168.1.51:631/ipp/print');
  assert.deepEqual(
    tried.slice(0, 2),
    ['http://192.168.1.51:631/ipp/print', 'https://192.168.1.51:631/ipp/print'],
    'the https twin must be tried right after the 426, before the other paths',
  );
});

test('getPrinterAttributes does not retry variants on a network failure', async () => {
  resetVariantCache();
  // Nothing listens on this port: every variant would fail identically.
  await assert.rejects(
    () => getPrinterAttributes('http://127.0.0.1:9/ipp/print', { timeoutMs: 2000 }),
    /fetch failed|ECONNREFUSED/,
  );
});
