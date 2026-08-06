// -----------------------------------------------------------------------------
// IPP compatibility cascade, exercised against a real local HTTP server that
// mimics a minimalist firmware (Epson EcoTank style): HTTP 500 on IPP 1.1,
// success on IPP 2.0.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getPrinterAttributes, resetVariantCache } from '../src/ipp/client.js';
import { decodeMessage, encodeGetPrinterAttributes } from '../src/ipp/message.js';
import { colorInkjetResponse } from './helpers/ippFixtures.js';

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

test('getPrinterAttributes does not retry variants on a network failure', async () => {
  resetVariantCache();
  // Nothing listens on this port: every variant would fail identically.
  await assert.rejects(
    () => getPrinterAttributes('http://127.0.0.1:9/ipp/print', { timeoutMs: 2000 }),
    /fetch failed|ECONNREFUSED/,
  );
});
