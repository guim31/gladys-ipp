// -----------------------------------------------------------------------------
// IPP protocol constants (RFC 8010 encoding / RFC 8011 semantics).
//
// IPP is a binary TLV protocol carried over HTTP POST (content-type
// application/ipp, port 631). Only the small subset needed to read printer
// attributes is declared here.
// -----------------------------------------------------------------------------

// Operation ids.
export const OPERATIONS = {
  GET_PRINTER_ATTRIBUTES: 0x000b,
};

// Delimiter tags (they open an attribute group; values are < 0x10).
export const GROUPS = {
  OPERATION_ATTRIBUTES: 0x01,
  JOB_ATTRIBUTES: 0x02,
  END_OF_ATTRIBUTES: 0x03,
  PRINTER_ATTRIBUTES: 0x04,
  UNSUPPORTED_ATTRIBUTES: 0x05,
};

// Value tags (they prefix every attribute value; values are >= 0x10).
export const TAGS = {
  UNSUPPORTED: 0x10,
  UNKNOWN: 0x12,
  NO_VALUE: 0x13,
  INTEGER: 0x21,
  BOOLEAN: 0x22,
  ENUM: 0x23,
  OCTET_STRING: 0x30,
  DATE_TIME: 0x31,
  RESOLUTION: 0x32,
  RANGE_OF_INTEGER: 0x33,
  BEG_COLLECTION: 0x34,
  TEXT_WITH_LANGUAGE: 0x35,
  NAME_WITH_LANGUAGE: 0x36,
  END_COLLECTION: 0x37,
  TEXT_WITHOUT_LANGUAGE: 0x41,
  NAME_WITHOUT_LANGUAGE: 0x42,
  KEYWORD: 0x44,
  URI: 0x45,
  URI_SCHEME: 0x46,
  CHARSET: 0x47,
  NATURAL_LANGUAGE: 0x48,
  MIME_MEDIA_TYPE: 0x49,
  MEMBER_ATTR_NAME: 0x4a,
};

// Status codes: everything <= 0x00ff is a flavor of "successful-ok".
export const STATUS = {
  SUCCESSFUL_OK_MAX: 0x00ff,
};

// printer-state enum values (RFC 8011 §5.4.11).
export const PRINTER_STATES = {
  3: 'idle',
  4: 'printing',
  5: 'stopped',
};
