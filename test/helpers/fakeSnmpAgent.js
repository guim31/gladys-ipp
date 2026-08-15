// -----------------------------------------------------------------------------
// A real (tiny) SNMP agent over UDP, so the walk is exercised on the wire
// instead of against a mock — same spirit as the fake IPP printers of
// test/compat.test.js.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import {
  BER,
  compareOids,
  decodeInteger,
  decodeOidValue,
  encodeInteger,
  encodeOidValue,
  encodeTlv,
  readTlv,
} from '../../src/snmp/ber.js';

/**
 * Encode one MIB value into its BER TLV.
 * @param {number|string} value
 * @returns {Buffer}
 */
function encodeValue(value) {
  return typeof value === 'number'
    ? encodeTlv(BER.INTEGER, encodeInteger(value))
    : encodeTlv(BER.OCTET_STRING, Buffer.from(String(value), 'utf8'));
}

/**
 * Start a fake SNMP agent serving the given MIB.
 * @param {Record<string, number|string>} mib oid -> value
 * @param {{ silent?: boolean }} [options] `silent` never answers (firewalled printer)
 * @returns {Promise<{ port: number, requests: string[], close: () => Promise<void> }>}
 */
export function startFakeSnmpAgent(mib, { silent = false } = {}) {
  const sorted = Object.keys(mib).sort(compareOids);
  const requests = [];
  const socket = dgram.createSocket('udp4');

  socket.on('message', (payload, rinfo) => {
    const envelope = readTlv(payload);
    let offset = readTlv(envelope.value, 0).next; // version
    const community = readTlv(envelope.value, offset);
    offset = community.next;
    const pdu = readTlv(envelope.value, offset);

    let pduOffset = 0;
    const requestIdTlv = readTlv(pdu.value, pduOffset);
    pduOffset = requestIdTlv.next;
    pduOffset = readTlv(pdu.value, pduOffset).next; // error-status
    pduOffset = readTlv(pdu.value, pduOffset).next; // error-index
    const varbindList = readTlv(pdu.value, pduOffset);
    const entry = readTlv(varbindList.value, 0);
    const askedOid = decodeOidValue(readTlv(entry.value, 0).value);
    requests.push(askedOid);

    if (silent) {
      return;
    }

    // GetNext: the first OID of the MIB strictly greater than the asked one.
    const nextOid = sorted.find((oid) => compareOids(oid, askedOid) > 0);
    const answerVarbind =
      nextOid === undefined
        ? encodeTlv(
            BER.SEQUENCE,
            Buffer.concat([
              encodeTlv(BER.OID, encodeOidValue(askedOid)),
              encodeTlv(BER.END_OF_MIB_VIEW, Buffer.alloc(0)),
            ]),
          )
        : encodeTlv(
            BER.SEQUENCE,
            Buffer.concat([encodeTlv(BER.OID, encodeOidValue(nextOid)), encodeValue(mib[nextOid])]),
          );

    const responsePdu = encodeTlv(
      BER.GET_RESPONSE,
      Buffer.concat([
        encodeTlv(BER.INTEGER, encodeInteger(decodeInteger(requestIdTlv.value))),
        encodeTlv(BER.INTEGER, encodeInteger(0)),
        encodeTlv(BER.INTEGER, encodeInteger(0)),
        encodeTlv(BER.SEQUENCE, answerVarbind),
      ]),
    );
    const response = encodeTlv(
      BER.SEQUENCE,
      Buffer.concat([
        encodeTlv(BER.INTEGER, encodeInteger(0)),
        encodeTlv(BER.OCTET_STRING, community.value),
        responsePdu,
      ]),
    );
    socket.send(response, rinfo.port, rinfo.address);
  });

  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => {
      resolve({
        port: socket.address().port,
        requests,
        close: () => new Promise((done) => socket.close(done)),
      });
    });
  });
}

/** A realistic Epson EcoTank supply table (4 inks + a maintenance box). */
export const ECOTANK_MIB = {
  // prtMarkerSuppliesType: 5 = ink, 8 = wasteInk
  '1.3.6.1.2.1.43.11.1.1.5.1.1': 5,
  '1.3.6.1.2.1.43.11.1.1.5.1.2': 5,
  '1.3.6.1.2.1.43.11.1.1.5.1.3': 5,
  '1.3.6.1.2.1.43.11.1.1.5.1.4': 5,
  '1.3.6.1.2.1.43.11.1.1.5.1.5': 8,
  // prtMarkerSuppliesDescription
  '1.3.6.1.2.1.43.11.1.1.6.1.1': 'Black ink',
  '1.3.6.1.2.1.43.11.1.1.6.1.2': 'Cyan ink',
  '1.3.6.1.2.1.43.11.1.1.6.1.3': 'Magenta ink',
  '1.3.6.1.2.1.43.11.1.1.6.1.4': 'Yellow ink',
  '1.3.6.1.2.1.43.11.1.1.6.1.5': 'Maintenance Box',
  // prtMarkerSuppliesMaxCapacity
  '1.3.6.1.2.1.43.11.1.1.8.1.1': 100,
  '1.3.6.1.2.1.43.11.1.1.8.1.2': 100,
  '1.3.6.1.2.1.43.11.1.1.8.1.3': 100,
  '1.3.6.1.2.1.43.11.1.1.8.1.4': 100,
  '1.3.6.1.2.1.43.11.1.1.8.1.5': 100,
  // prtMarkerSuppliesLevel — the 4th ink is unknown (-2), a real-world case
  '1.3.6.1.2.1.43.11.1.1.9.1.1': 76,
  '1.3.6.1.2.1.43.11.1.1.9.1.2': 51,
  '1.3.6.1.2.1.43.11.1.1.9.1.3': 33,
  '1.3.6.1.2.1.43.11.1.1.9.1.4': -2,
  '1.3.6.1.2.1.43.11.1.1.9.1.5': 90,
};
