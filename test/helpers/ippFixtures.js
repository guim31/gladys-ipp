// -----------------------------------------------------------------------------
// Test fixtures: build realistic binary IPP responses, and provide the parsed
// attributes of a typical color inkjet printer.
// -----------------------------------------------------------------------------

import { GROUPS, TAGS } from '../../src/ipp/constants.js';

/**
 * Encode one attribute (with 1setOf support) for a synthetic response.
 * `values` entries are { tag, value } where value is a string, a number
 * (int32) or a Buffer.
 */
function attr(name, values) {
  const chunks = [];
  values.forEach(({ tag, value }, index) => {
    let valueBuf;
    if (Buffer.isBuffer(value)) {
      valueBuf = value;
    } else if (typeof value === 'number') {
      valueBuf = Buffer.alloc(4);
      valueBuf.writeInt32BE(value, 0);
    } else {
      valueBuf = Buffer.from(String(value), 'utf8');
    }
    const nameBuf = Buffer.from(index === 0 ? name : '', 'utf8');
    const head = Buffer.alloc(3);
    head.writeUInt8(tag, 0);
    head.writeUInt16BE(nameBuf.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(valueBuf.length, 0);
    chunks.push(head, nameBuf, len, valueBuf);
  });
  return Buffer.concat(chunks);
}

/**
 * Build a complete binary Get-Printer-Attributes RESPONSE.
 * @param {{ statusCode?: number, requestId?: number, printerAttrs?: Buffer[] }} options
 */
export function buildIppResponse({ statusCode = 0x0000, requestId = 1, printerAttrs = [] } = {}) {
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt8(1, 1);
  header.writeUInt16BE(statusCode, 2);
  header.writeUInt32BE(requestId, 4);

  return Buffer.concat([
    header,
    Buffer.from([GROUPS.OPERATION_ATTRIBUTES]),
    attr('attributes-charset', [{ tag: TAGS.CHARSET, value: 'utf-8' }]),
    attr('attributes-natural-language', [{ tag: TAGS.NATURAL_LANGUAGE, value: 'en' }]),
    Buffer.from([GROUPS.PRINTER_ATTRIBUTES]),
    ...printerAttrs,
    Buffer.from([GROUPS.END_OF_ATTRIBUTES]),
  ]);
}

/** Binary response of a typical 4-cartridge color inkjet. */
export function colorInkjetResponse() {
  return buildIppResponse({
    printerAttrs: [
      attr('printer-name', [{ tag: TAGS.NAME_WITHOUT_LANGUAGE, value: 'HP-Office' }]),
      attr('printer-make-and-model', [
        { tag: TAGS.TEXT_WITHOUT_LANGUAGE, value: 'HP OfficeJet Pro 9010' },
      ]),
      attr('printer-uuid', [
        { tag: TAGS.URI, value: 'urn:uuid:12345678-90ab-cdef-1234-567890abcdef' },
      ]),
      attr('printer-state', [{ tag: TAGS.ENUM, value: 3 }]),
      attr('printer-state-reasons', [{ tag: TAGS.KEYWORD, value: 'none' }]),
      attr('marker-names', [
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: 'Black Cartridge' },
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: 'Cyan Cartridge' },
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: 'Magenta Cartridge' },
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: 'Yellow Cartridge' },
      ]),
      attr('marker-levels', [
        { tag: TAGS.INTEGER, value: 42 },
        { tag: TAGS.INTEGER, value: 71 },
        { tag: TAGS.INTEGER, value: 18 },
        { tag: TAGS.INTEGER, value: 93 },
      ]),
      attr('marker-colors', [
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: '#000000' },
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: '#00FFFF' },
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: '#FF00FF' },
        { tag: TAGS.NAME_WITHOUT_LANGUAGE, value: '#FFFF00' },
      ]),
      attr('marker-types', [
        { tag: TAGS.KEYWORD, value: 'ink-cartridge' },
        { tag: TAGS.KEYWORD, value: 'ink-cartridge' },
        { tag: TAGS.KEYWORD, value: 'ink-cartridge' },
        { tag: TAGS.KEYWORD, value: 'ink-cartridge' },
      ]),
      attr('marker-high-levels', [
        { tag: TAGS.INTEGER, value: 100 },
        { tag: TAGS.INTEGER, value: 100 },
        { tag: TAGS.INTEGER, value: 100 },
        { tag: TAGS.INTEGER, value: 100 },
      ]),
    ],
  });
}

/** Parsed attributes matching colorInkjetResponse(), for tests that skip the wire. */
export const COLOR_INKJET_ATTRIBUTES = {
  'printer-name': 'HP-Office',
  'printer-make-and-model': 'HP OfficeJet Pro 9010',
  'printer-uuid': 'urn:uuid:12345678-90ab-cdef-1234-567890abcdef',
  'printer-state': 3,
  'printer-state-reasons': 'none',
  'marker-names': ['Black Cartridge', 'Cyan Cartridge', 'Magenta Cartridge', 'Yellow Cartridge'],
  'marker-levels': [42, 71, 18, 93],
  'marker-colors': ['#000000', '#00FFFF', '#FF00FF', '#FFFF00'],
  'marker-types': ['ink-cartridge', 'ink-cartridge', 'ink-cartridge', 'ink-cartridge'],
  'marker-high-levels': [100, 100, 100, 100],
};

export { attr };
