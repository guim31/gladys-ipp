// -----------------------------------------------------------------------------
// The slice of ASN.1 BER that SNMP needs (X.690).
//
// Same spirit as src/ipp/message.js: pure functions over Buffers, no I/O, so
// the wire format is testable without a printer. A BER value is a TLV:
//   tag     1 byte
//   length  1 byte (< 0x80) or 0x80|n followed by n big-endian bytes
//   value   `length` bytes
// -----------------------------------------------------------------------------

export const BER = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  // SNMP PDUs are context-specific constructed types.
  GET_NEXT_REQUEST: 0xa1,
  GET_RESPONSE: 0xa2,
  // Application types a printer may answer with, all integer-shaped.
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  COUNTER64: 0x46,
  // "This OID does not exist / the walk is over" markers (SNMPv2 style, but
  // agents send them to v1 clients too).
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,
};

/**
 * Encode a BER length.
 * @param {number} length
 * @returns {Buffer}
 */
export function encodeLength(length) {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Encode one TLV.
 * @param {number} tag
 * @param {Buffer} value
 * @returns {Buffer}
 */
export function encodeTlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

/**
 * Encode a signed integer in minimal two's-complement form.
 * @param {number} value
 * @returns {Buffer}
 */
export function encodeInteger(value) {
  const bytes = [];
  let rest = Math.trunc(value);
  for (;;) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
    const signBitSet = (bytes[0] & 0x80) !== 0;
    // Stop as soon as the sign is unambiguous: a leading 0x00 for positives,
    // a leading 0xff for negatives, and nothing more.
    if ((rest === 0 && !signBitSet) || (rest === -1 && signBitSet)) {
      break;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Encode an OID ('1.3.6.1.2.1.43...') into its BER value bytes.
 * @param {string} oid dotted notation
 * @returns {Buffer}
 */
export function encodeOidValue(oid) {
  const arcs = String(oid)
    .split('.')
    .filter((arc) => arc !== '')
    .map(Number);
  if (arcs.length < 2) {
    throw new Error(`Invalid OID "${oid}"`);
  }
  // The first two arcs share one byte.
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const base128 = [arc % 128];
    let rest = Math.floor(arc / 128);
    while (rest > 0) {
      base128.unshift((rest % 128) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...base128);
  }
  return Buffer.from(bytes);
}

/**
 * Read one TLV at `offset`.
 * @param {Buffer} buffer
 * @param {number} [offset]
 * @returns {{ tag: number, value: Buffer, next: number }}
 */
export function readTlv(buffer, offset = 0) {
  if (offset + 2 > buffer.length) {
    throw new Error('Truncated BER header');
  }
  const tag = buffer.readUInt8(offset);
  const first = buffer.readUInt8(offset + 1);
  let length = first;
  let valueStart = offset + 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (valueStart + count > buffer.length) {
      throw new Error('Truncated BER length');
    }
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + buffer.readUInt8(valueStart + i);
    }
    valueStart += count;
  }
  const valueEnd = valueStart + length;
  if (valueEnd > buffer.length) {
    throw new Error('Truncated BER value');
  }
  return { tag, value: buffer.subarray(valueStart, valueEnd), next: valueEnd };
}

/**
 * Decode a signed BER integer.
 * @param {Buffer} value
 * @returns {number}
 */
export function decodeInteger(value) {
  if (value.length === 0) {
    return 0;
  }
  // The first byte carries the sign, the rest are plain base-256 digits.
  let result = value.readInt8(0);
  for (let i = 1; i < value.length; i += 1) {
    result = result * 256 + value.readUInt8(i);
  }
  return result;
}

/**
 * Decode an OID value back to dotted notation.
 * @param {Buffer} value
 * @returns {string}
 */
export function decodeOidValue(value) {
  if (value.length === 0) {
    return '';
  }
  const first = value.readUInt8(0);
  const arcs = [Math.floor(first / 40), first % 40];
  let current = 0;
  for (let i = 1; i < value.length; i += 1) {
    const byte = value.readUInt8(i);
    current = current * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(current);
      current = 0;
    }
  }
  return arcs.join('.');
}

/**
 * Is `oid` inside the `root` subtree (or equal to it)?
 * @param {string} oid
 * @param {string} root
 * @returns {boolean}
 */
export function isUnder(oid, root) {
  return oid === root || oid.startsWith(`${root}.`);
}

/**
 * Compare two OIDs arc by arc (lexicographic in the SNMP sense).
 * @param {string} a
 * @param {string} b
 * @returns {number} <0, 0 or >0
 */
export function compareOids(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? -1) - (right[i] ?? -1);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
