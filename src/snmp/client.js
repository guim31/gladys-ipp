// -----------------------------------------------------------------------------
// Minimal SNMPv1 client (UDP 161), just enough to walk a MIB subtree.
//
// Why SNMP in an IPP integration: some printers (Epson EcoTank...) answer IPP
// perfectly but never announce their supplies there — neither marker-* nor
// printer-supply. Those same printers do implement the Printer MIB
// (RFC 3805), which is exactly how CUPS reads their ink levels. This is the
// fallback used when IPP says nothing (see src/supplies.js).
//
// Only unicast queries to a printer the integration is ALREADY talking to
// over IPP are sent: no sweep, no broadcast, no other host.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  BER,
  compareOids,
  decodeInteger,
  decodeOidValue,
  encodeInteger,
  encodeOidValue,
  encodeTlv,
  isUnder,
  readTlv,
} from './ber.js';

const logger = createLogger({ name: 'snmp' });

export const DEFAULT_SNMP_PORT = 161;
export const DEFAULT_COMMUNITY = 'public';

// SNMP version field: 0 means v1, the dialect every printer speaks.
const VERSION_V1 = 0;

/**
 * Build a GetNextRequest message for one OID.
 * @param {string} oid
 * @param {{ community: string, requestId: number }} options
 * @returns {Buffer}
 */
export function encodeGetNextRequest(oid, { community, requestId }) {
  const varbind = encodeTlv(
    BER.SEQUENCE,
    Buffer.concat([encodeTlv(BER.OID, encodeOidValue(oid)), encodeTlv(BER.NULL, Buffer.alloc(0))]),
  );
  const pdu = encodeTlv(
    BER.GET_NEXT_REQUEST,
    Buffer.concat([
      encodeTlv(BER.INTEGER, encodeInteger(requestId)),
      encodeTlv(BER.INTEGER, encodeInteger(0)), // error-status
      encodeTlv(BER.INTEGER, encodeInteger(0)), // error-index
      encodeTlv(BER.SEQUENCE, varbind),
    ]),
  );
  return encodeTlv(
    BER.SEQUENCE,
    Buffer.concat([
      encodeTlv(BER.INTEGER, encodeInteger(VERSION_V1)),
      encodeTlv(BER.OCTET_STRING, Buffer.from(community, 'utf8')),
      pdu,
    ]),
  );
}

/**
 * Decode an SNMP response into its first varbind.
 * @param {Buffer} buffer
 * @returns {{ requestId: number, errorStatus: number,
 *             varbind: { oid: string, tag: number, value: Buffer }|null }}
 */
export function decodeResponse(buffer) {
  const envelope = readTlv(buffer);
  let offset = 0;
  const body = envelope.value;
  const version = readTlv(body, offset);
  offset = version.next;
  const community = readTlv(body, offset);
  offset = community.next;
  const pdu = readTlv(body, offset);
  if (pdu.tag !== BER.GET_RESPONSE) {
    throw new Error(`Unexpected SNMP PDU 0x${pdu.tag.toString(16)}`);
  }

  let pduOffset = 0;
  const requestIdTlv = readTlv(pdu.value, pduOffset);
  pduOffset = requestIdTlv.next;
  const errorStatusTlv = readTlv(pdu.value, pduOffset);
  pduOffset = errorStatusTlv.next;
  const errorIndexTlv = readTlv(pdu.value, pduOffset);
  pduOffset = errorIndexTlv.next;
  const varbindList = readTlv(pdu.value, pduOffset);

  let varbind = null;
  if (varbindList.value.length > 0) {
    const entry = readTlv(varbindList.value, 0);
    const oidTlv = readTlv(entry.value, 0);
    const valueTlv = readTlv(entry.value, oidTlv.next);
    varbind = {
      oid: decodeOidValue(oidTlv.value),
      tag: valueTlv.tag,
      value: valueTlv.value,
    };
  }

  return {
    requestId: decodeInteger(requestIdTlv.value),
    errorStatus: decodeInteger(errorStatusTlv.value),
    varbind,
  };
}

/**
 * Turn a varbind into a JS value: integers for the numeric types, strings for
 * octet strings, null for the "no such object" markers.
 * @param {{ tag: number, value: Buffer }} varbind
 * @returns {number|string|null}
 */
export function varbindValue({ tag, value }) {
  switch (tag) {
    case BER.INTEGER:
    case BER.COUNTER32:
    case BER.GAUGE32:
    case BER.TIMETICKS:
    case BER.COUNTER64:
      return decodeInteger(value);
    case BER.OCTET_STRING:
      // Printer MIB descriptions are plain text; trim the trailing NULs some
      // firmwares pad them with.
      return value.toString('utf8').replace(/\0+$/, '').trim();
    case BER.OID:
      return decodeOidValue(value);
    default:
      return null;
  }
}

/**
 * Send one datagram and wait for its answer.
 * @param {import('node:dgram').Socket} socket
 * @param {Buffer} message
 * @param {{ host: string, port: number, timeoutMs: number, requestId: number }} options
 * @returns {Promise<Buffer>}
 */
function exchange(socket, message, { host, port, timeoutMs, requestId }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    const onMessage = (payload) => {
      // Ignore late answers to a previous request of the same walk.
      try {
        if (decodeResponse(payload).requestId !== requestId) {
          return;
        }
      } catch {
        return; // not something we can read: keep waiting
      }
      settled = true;
      cleanup();
      resolve(payload);
    };
    const onError = (err) => {
      settled = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(new Error(`SNMP timeout after ${timeoutMs} ms`));
      }
    }, timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.send(message, port, host, (err) => {
      if (err && !settled) {
        cleanup();
        reject(err);
      }
    });
  });
}

/**
 * Walk a MIB subtree with successive GetNextRequests.
 * Never throws for a printer that simply does not answer: an unreachable or
 * SNMP-less printer returns an empty array, like a subtree with no row.
 * @param {string} host printer IP or hostname
 * @param {string} rootOid subtree to walk
 * @param {{ port?: number, community?: string, timeoutMs?: number, maxRows?: number }} [options]
 * @returns {Promise<Array<{ oid: string, value: number|string|null }>>}
 */
export async function snmpWalk(host, rootOid, options = {}) {
  const {
    port = DEFAULT_SNMP_PORT,
    community = DEFAULT_COMMUNITY,
    timeoutMs = 2000,
    maxRows = 64,
  } = options;

  const socket = dgram.createSocket('udp4');
  const rows = [];
  try {
    let current = rootOid;
    for (let i = 0; i < maxRows; i += 1) {
      const requestId = i + 1;
      const payload = await exchange(
        socket,
        encodeGetNextRequest(current, { community, requestId }),
        {
          host,
          port,
          timeoutMs,
          requestId,
        },
      );
      const { errorStatus, varbind } = decodeResponse(payload);
      if (errorStatus !== 0 || varbind === null) {
        break;
      }
      // End of the subtree, end of the MIB, or an agent that stopped moving
      // forward (loop protection).
      if (
        !isUnder(varbind.oid, rootOid) ||
        varbind.tag === BER.END_OF_MIB_VIEW ||
        varbind.tag === BER.NO_SUCH_OBJECT ||
        varbind.tag === BER.NO_SUCH_INSTANCE ||
        compareOids(varbind.oid, current) <= 0
      ) {
        break;
      }
      rows.push({ oid: varbind.oid, value: varbindValue(varbind) });
      current = varbind.oid;
    }
  } catch (err) {
    logger.debug(`SNMP walk of ${rootOid} on ${host} stopped: ${err.message}`);
  } finally {
    try {
      socket.close();
    } catch {
      // already closed by an error event: nothing to do
    }
  }
  return rows;
}
