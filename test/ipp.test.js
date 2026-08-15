import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, TAGS } from '../src/ipp/constants.js';
import {
  decodeMessage,
  encodeGetPrinterAttributes,
  printerAttributes,
} from '../src/ipp/message.js';
import { candidateUrls, probePrinter, toIppUri } from '../src/ipp/client.js';
import { attr, buildIppResponse, colorInkjetResponse } from './helpers/ippFixtures.js';

// --- encoding ----------------------------------------------------------------

test('encodeGetPrinterAttributes produces a decodable IPP 1.1 request', () => {
  const buffer = encodeGetPrinterAttributes('ipp://192.168.1.20:631/ipp/print', [
    'printer-state',
    'marker-levels',
  ]);
  // Same TLV framing for requests and responses: reuse the decoder.
  const message = decodeMessage(buffer);
  assert.equal(message.version, '1.1');
  assert.equal(message.statusCode, 0x000b); // operation-id slot
  assert.equal(message.requestId, 1);

  const [operation] = message.groups;
  assert.equal(operation.tag, GROUPS.OPERATION_ATTRIBUTES);
  assert.equal(operation.attributes['attributes-charset'], 'utf-8');
  assert.equal(operation.attributes['attributes-natural-language'], 'en');
  assert.equal(operation.attributes['printer-uri'], 'ipp://192.168.1.20:631/ipp/print');
  assert.deepEqual(operation.attributes['requested-attributes'], [
    'printer-state',
    'marker-levels',
  ]);
});

// --- decoding ----------------------------------------------------------------

test('decodeMessage parses a full printer response (1setOf, enum, strings)', () => {
  const message = decodeMessage(colorInkjetResponse());
  assert.equal(message.statusCode, 0x0000);

  const attrs = printerAttributes(message);
  assert.equal(attrs['printer-make-and-model'], 'HP OfficeJet Pro 9010');
  assert.equal(attrs['printer-state'], 3);
  assert.deepEqual(attrs['marker-levels'], [42, 71, 18, 93]);
  assert.deepEqual(attrs['marker-names'], [
    'Black Cartridge',
    'Cyan Cartridge',
    'Magenta Cartridge',
    'Yellow Cartridge',
  ]);
});

test('decodeMessage keeps a single-valued attribute as a scalar', () => {
  const buffer = buildIppResponse({
    printerAttrs: [attr('marker-levels', [{ tag: TAGS.INTEGER, value: 55 }])],
  });
  const attrs = printerAttributes(decodeMessage(buffer));
  assert.equal(attrs['marker-levels'], 55);
});

test('decodeMessage decodes textWithLanguage values', () => {
  const lang = Buffer.from('en', 'utf8');
  const text = Buffer.from('Ready', 'utf8');
  const value = Buffer.alloc(2 + lang.length + 2 + text.length);
  value.writeUInt16BE(lang.length, 0);
  lang.copy(value, 2);
  value.writeUInt16BE(text.length, 2 + lang.length);
  text.copy(value, 2 + lang.length + 2);

  const buffer = buildIppResponse({
    printerAttrs: [attr('printer-state-message', [{ tag: TAGS.TEXT_WITH_LANGUAGE, value }])],
  });
  const attrs = printerAttributes(decodeMessage(buffer));
  assert.equal(attrs['printer-state-message'], 'Ready');
});

test('decodeMessage rejects a truncated message', () => {
  const truncated = colorInkjetResponse().subarray(0, 20);
  assert.throws(() => decodeMessage(truncated), /Truncated/);
});

test('decodeMessage rejects a too-short buffer', () => {
  assert.throws(() => decodeMessage(Buffer.from([1, 1, 0, 0])), /too short/);
});

// --- URL handling ------------------------------------------------------------

test('candidateUrls expands a bare IP to the default IPP endpoints', () => {
  assert.deepEqual(candidateUrls('192.168.1.20'), [
    'http://192.168.1.20:631/ipp/print',
    'http://192.168.1.20:631/ipp',
    'http://192.168.1.20:631/',
  ]);
});

test('candidateUrls keeps an explicit port', () => {
  assert.equal(candidateUrls('printer.local:8631')[0], 'http://printer.local:8631/ipp/print');
});

test('candidateUrls trusts an ipp:// URI with an explicit path', () => {
  assert.deepEqual(candidateUrls('ipp://192.168.1.30/ipp/print'), [
    'http://192.168.1.30:631/ipp/print',
  ]);
});

test('candidateUrls expands an ipp:// URI without a path', () => {
  assert.equal(candidateUrls('ipp://192.168.1.30').length, 3);
});

test('candidateUrls maps ipps:// to https', () => {
  assert.equal(candidateUrls('ipps://printer.local/ipp/print')[0].startsWith('https://'), true);
});

test('candidateUrls returns nothing for an empty target', () => {
  assert.deepEqual(candidateUrls('  '), []);
});

test('toIppUri converts the HTTP URL back to the in-message printer-uri', () => {
  assert.equal(toIppUri('http://192.168.1.20:631/ipp/print'), 'ipp://192.168.1.20:631/ipp/print');
  assert.equal(
    toIppUri('https://printer.local:443/ipp/print'),
    'ipps://printer.local:443/ipp/print',
  );
});

// --- probing -----------------------------------------------------------------

test('probePrinter falls back to the next candidate URL', async () => {
  const tried = [];
  const fetchAttributes = async (url) => {
    tried.push(url);
    if (url.endsWith('/ipp')) {
      return { 'printer-state': 3 };
    }
    throw new Error('ECONNREFUSED');
  };
  const { url, attributes } = await probePrinter('192.168.1.20', { fetchAttributes });
  assert.equal(url, 'http://192.168.1.20:631/ipp');
  assert.equal(attributes['printer-state'], 3);
  assert.equal(tried.length, 2);
});

test('probePrinter reports the last error when every candidate fails', async () => {
  const fetchAttributes = async () => {
    throw new Error('timeout');
  };
  await assert.rejects(
    () => probePrinter('192.168.1.20', { fetchAttributes }),
    /unreachable over IPP \(timeout\)/,
  );
});

test('probePrinter rejects an empty target', async () => {
  await assert.rejects(() => probePrinter(''), /Empty printer target/);
});

test('decodeMessage decodes octetStrings (printer-supply) as text', () => {
  const supply = 'index=1;type=ink;maxcapacity=100;level=57;colorantname=black;';
  const buffer = buildIppResponse({
    printerAttrs: [attr('printer-supply', [{ tag: TAGS.OCTET_STRING, value: supply }])],
  });
  const attrs = printerAttributes(decodeMessage(buffer));
  assert.equal(attrs['printer-supply'], supply);
});
