// -----------------------------------------------------------------------------
// IPP message encoding / decoding (RFC 8010).
//
// An IPP message is:
//   version-number      2 bytes (major, minor)
//   operation-id or
//   status-code         2 bytes (big endian)
//   request-id          4 bytes (big endian)
//   attribute groups    delimiter tag (1 byte) then attributes
//   end-of-attributes   0x03
//
// Each attribute is:
//   value-tag  1 byte
//   name-len   2 bytes + name   (empty name = additional value of the
//                                previous attribute, i.e. a 1setOf)
//   value-len  2 bytes + value
//
// Pure functions over Buffers: no I/O here (see client.js for the HTTP part).
// -----------------------------------------------------------------------------

import { GROUPS, OPERATIONS, TAGS } from './constants.js';

/**
 * Encode one attribute (with possibly several values, i.e. a 1setOf).
 * @param {number} tag IPP value tag
 * @param {string} name attribute name
 * @param {string[]} values attribute values (UTF-8 strings)
 * @returns {Buffer}
 */
function encodeAttribute(tag, name, values) {
  const chunks = [];
  values.forEach((value, index) => {
    const nameBuf = Buffer.from(index === 0 ? name : '', 'utf8');
    const valueBuf = Buffer.from(value, 'utf8');
    const head = Buffer.alloc(1 + 2);
    head.writeUInt8(tag, 0);
    head.writeUInt16BE(nameBuf.length, 1);
    const valueLen = Buffer.alloc(2);
    valueLen.writeUInt16BE(valueBuf.length, 0);
    chunks.push(head, nameBuf, valueLen, valueBuf);
  });
  return Buffer.concat(chunks);
}

/**
 * Encode a Get-Printer-Attributes request.
 *
 * `requesting-user-name` is optional per the RFC but some minimalist
 * firmwares (Epson EcoTank...) answer HTTP 500 without it, so it is always
 * sent. A null `requestedAttributes` omits the attribute entirely: the
 * server then defaults to 'all' — the fallback for firmwares that choke on
 * an explicit list.
 * @param {string} printerUri the ipp:// URI of the printer (goes INSIDE the message)
 * @param {string[]|null} requestedAttributes attribute names, or null for server-default (all)
 * @param {number} [requestId]
 * @param {{ version?: [number, number] }} [options] IPP version, default 1.1
 * @returns {Buffer}
 */
export function encodeGetPrinterAttributes(
  printerUri,
  requestedAttributes,
  requestId = 1,
  { version = [1, 1] } = {},
) {
  const header = Buffer.alloc(8);
  header.writeUInt8(version[0], 0);
  header.writeUInt8(version[1], 1);
  header.writeUInt16BE(OPERATIONS.GET_PRINTER_ATTRIBUTES, 2);
  header.writeUInt32BE(requestId, 4);

  return Buffer.concat([
    header,
    Buffer.from([GROUPS.OPERATION_ATTRIBUTES]),
    // The order of the first three operation attributes is mandated by the RFC.
    encodeAttribute(TAGS.CHARSET, 'attributes-charset', ['utf-8']),
    encodeAttribute(TAGS.NATURAL_LANGUAGE, 'attributes-natural-language', ['en']),
    encodeAttribute(TAGS.URI, 'printer-uri', [printerUri]),
    encodeAttribute(TAGS.NAME_WITHOUT_LANGUAGE, 'requesting-user-name', ['gladys-ipp']),
    ...(requestedAttributes && requestedAttributes.length > 0
      ? [encodeAttribute(TAGS.KEYWORD, 'requested-attributes', requestedAttributes)]
      : []),
    Buffer.from([GROUPS.END_OF_ATTRIBUTES]),
  ]);
}

/**
 * Decode one attribute value according to its tag.
 * Integers/enums/booleans/strings are decoded; anything exotic (dateTime,
 * resolution, collections...) is returned as a raw Buffer — the integration
 * never requests those, but a printer may still send them.
 * @param {number} tag
 * @param {Buffer} value
 */
function decodeValue(tag, value) {
  switch (tag) {
    case TAGS.INTEGER:
    case TAGS.ENUM:
      return value.length >= 4 ? value.readInt32BE(0) : null;
    case TAGS.BOOLEAN:
      return value.length >= 1 ? value.readUInt8(0) !== 0 : null;
    case TAGS.RANGE_OF_INTEGER:
      return value.length >= 8 ? { min: value.readInt32BE(0), max: value.readInt32BE(4) } : null;
    case TAGS.TEXT_WITH_LANGUAGE:
    case TAGS.NAME_WITH_LANGUAGE: {
      // [lang-len][lang][text-len][text] — only the text part matters here.
      if (value.length < 4) {
        return value.toString('utf8');
      }
      const langLen = value.readUInt16BE(0);
      const textLenOffset = 2 + langLen;
      if (value.length < textLenOffset + 2) {
        return value.toString('utf8');
      }
      const textLen = value.readUInt16BE(textLenOffset);
      return value.subarray(textLenOffset + 2, textLenOffset + 2 + textLen).toString('utf8');
    }
    case TAGS.NO_VALUE:
    case TAGS.UNKNOWN:
    case TAGS.UNSUPPORTED:
      return null;
    case TAGS.OCTET_STRING:
      // The octetStrings the integration reads (printer-supply, PWG 5100.13)
      // carry readable "key=value;" pairs: decode as text.
      return value.toString('utf8');
    case TAGS.TEXT_WITHOUT_LANGUAGE:
    case TAGS.NAME_WITHOUT_LANGUAGE:
    case TAGS.KEYWORD:
    case TAGS.URI:
    case TAGS.URI_SCHEME:
    case TAGS.CHARSET:
    case TAGS.NATURAL_LANGUAGE:
    case TAGS.MIME_MEDIA_TYPE:
    case TAGS.MEMBER_ATTR_NAME:
      return value.toString('utf8');
    default:
      return value;
  }
}

/**
 * Decode an IPP message (response OR request: same framing).
 * @param {Buffer} buffer
 * @returns {{
 *   version: string,
 *   statusCode: number,
 *   requestId: number,
 *   groups: Array<{ tag: number, attributes: Record<string, unknown> }>,
 * }}
 */
export function decodeMessage(buffer) {
  if (buffer.length < 9) {
    throw new Error(`IPP message too short (${buffer.length} bytes)`);
  }
  const version = `${buffer.readUInt8(0)}.${buffer.readUInt8(1)}`;
  const statusCode = buffer.readUInt16BE(2);
  const requestId = buffer.readUInt32BE(4);

  const groups = [];
  let current = null;
  let lastName = null;
  let offset = 8;

  while (offset < buffer.length) {
    const tag = buffer.readUInt8(offset);
    if (tag === GROUPS.END_OF_ATTRIBUTES) {
      break;
    }
    if (tag < 0x10) {
      // Delimiter: a new attribute group starts.
      current = { tag, attributes: {} };
      groups.push(current);
      lastName = null;
      offset += 1;
      continue;
    }
    // Attribute (or additional value of the previous one).
    if (offset + 3 > buffer.length) {
      throw new Error('Truncated IPP attribute header');
    }
    const nameLen = buffer.readUInt16BE(offset + 1);
    offset += 3;
    if (offset + nameLen + 2 > buffer.length) {
      throw new Error('Truncated IPP attribute name');
    }
    const name = buffer.subarray(offset, offset + nameLen).toString('utf8');
    offset += nameLen;
    const valueLen = buffer.readUInt16BE(offset);
    offset += 2;
    if (offset + valueLen > buffer.length) {
      throw new Error('Truncated IPP attribute value');
    }
    const value = decodeValue(tag, buffer.subarray(offset, offset + valueLen));
    offset += valueLen;

    if (!current) {
      // Attribute before any delimiter: malformed, but be tolerant.
      current = { tag: GROUPS.OPERATION_ATTRIBUTES, attributes: {} };
      groups.push(current);
    }

    if (name === '') {
      // Additional value of the previous attribute (1setOf).
      if (lastName === null) {
        continue; // stray value (e.g. inside a collection): ignore
      }
      const existing = current.attributes[lastName];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        current.attributes[lastName] = [existing, value];
      }
    } else {
      current.attributes[name] = value;
      lastName = name;
    }
  }

  return { version, statusCode, requestId, groups };
}

/**
 * Merge all printer-attributes groups of a decoded message into one object.
 * @param {{ groups: Array<{ tag: number, attributes: Record<string, unknown> }> }} message
 * @returns {Record<string, unknown>}
 */
export function printerAttributes(message) {
  const merged = {};
  for (const group of message.groups) {
    if (group.tag === GROUPS.PRINTER_ATTRIBUTES) {
      Object.assign(merged, group.attributes);
    }
  }
  return merged;
}
