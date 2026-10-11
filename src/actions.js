// -----------------------------------------------------------------------------
// Manifest actions: buttons rendered in the Configuration screen.
// Each key here matches an entry of the `actions` field of
// `gladys-assistant-integration.json`; index.js registers them all.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { probePrinter } from './ipp/client.js';
import { parsePrinter } from './printer.js';
import { withFallbackSupplies } from './supplies.js';

const logger = createLogger({ name: 'actions' });

/** Languages of the action messages. */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Human-readable meaning of the IPP marker-levels sentinels (RFC 3805
// semantics carried over IPP: negative values flag a non-numeric answer),
// and of a marker missing from marker-levels.
export const RAW_LEVEL_TEXT = {
  en: {
    '-1': 'not reported (-1)',
    '-2': 'unknown (-2)',
    '-3': 'some left (-3)',
    missing: 'missing from marker-levels',
  },
  fr: {
    '-1': 'non communiqué (-1)',
    '-2': 'inconnu (-2)',
    '-3': 'il en reste (-3)',
    missing: 'valeur absente de marker-levels',
  },
  de: {
    '-1': 'nicht gemeldet (-1)',
    '-2': 'unbekannt (-2)',
    '-3': 'noch vorhanden (-3)',
    missing: 'fehlt in marker-levels',
  },
  es: {
    '-1': 'no informado (-1)',
    '-2': 'desconocido (-2)',
    '-3': 'queda algo (-3)',
    missing: 'ausente de marker-levels',
  },
};

// Fixed parts of the test answer, one entry per language.
export const ACTION_TEXTS = {
  noUsableSupply: {
    en: (list) => `no usable supply (unexploited attributes: ${list})`,
    fr: (list) => `aucun consommable exploitable (attributs non exploités : ${list})`,
    de: (list) => `kein verwertbares Verbrauchsmaterial (nicht ausgewertete Attribute: ${list})`,
    es: (list) => `ningún consumible utilizable (atributos no aprovechados: ${list})`,
  },
  noSupply: {
    en: 'no supply announced, over IPP nor SNMP',
    fr: 'aucun consommable annoncé, ni en IPP ni en SNMP',
    de: 'kein Verbrauchsmaterial gemeldet, weder über IPP noch über SNMP',
    es: 'ningún consumible anunciado, ni por IPP ni por SNMP',
  },
  viaSnmp: { en: ' (via SNMP)', fr: ' (via SNMP)', de: ' (über SNMP)', es: ' (por SNMP)' },
  plusSnmp: {
    en: (names) => ` (+ SNMP: ${names})`,
    fr: (names) => ` (+ SNMP : ${names})`,
    de: (names) => ` (+ SNMP: ${names})`,
    es: (names) => ` (+ SNMP: ${names})`,
  },
  printerOk: {
    en: (model, state) => `Printer OK: ${model} — state "${state}"`,
    fr: (model, state) => `Imprimante OK : ${model} — état « ${state} »`,
    de: (model, state) => `Drucker OK: ${model} — Status „${state}“`,
    es: (model, state) => `Impresora OK: ${model} — estado «${state}»`,
  },
};

/**
 * One text per language, built by `build(lang)`.
 * @param {(lang: string) => string} build
 * @returns {{ en: string, fr: string, de: string, es: string }}
 */
function perLanguage(build) {
  return Object.fromEntries(LANGUAGES.map((lang) => [lang, build(lang)]));
}

/**
 * Format the supplies of a parsed printer for the test action, in one
 * language. Unlike the device features, this shows EVERY supply the printer
 * announces — including the ones without a usable percentage, with the raw
 * IPP value explained. That is the diagnostic users paste on the forum when
 * a cartridge is missing from their device.
 * @param {{ markers: Array<{ name: string, percent: number|null, rawLevel: number|null }> }} printer
 * @param {'en'|'fr'|'de'|'es'} lang
 * @returns {string} e.g. "Black: unknown (-2), Cyan: 50%"
 */
export function formatSupplies(printer, lang) {
  const texts = RAW_LEVEL_TEXT[lang];
  return printer.markers
    .map((marker) => {
      if (marker.percent !== null) {
        return `${marker.name}: ${marker.percent}%`;
      }
      const raw =
        texts[String(marker.rawLevel)] ??
        (marker.rawLevel === null ? texts.missing : `${marker.rawLevel}`);
      return `${marker.name}: ${raw}`;
    })
    .join(', ');
}

/**
 * Explain WHY no supply was parsed from a raw IPP answer: supply-ish
 * attributes present but not exploited point at a parsing gap to report on
 * the forum; a raw answer without any means the printer does not announce
 * its supplies over IPP at all (proprietary app or SNMP only).
 * @param {Record<string, unknown>} attributes raw merged printer attributes
 * @returns {{ en: string, fr: string, de: string, es: string }}
 */
export function noSupplyDiagnostic(attributes) {
  const supplyKeys = Object.keys(attributes).filter((key) => /marker|supply|ink|toner/i.test(key));
  if (supplyKeys.length > 0) {
    const list = supplyKeys.join(', ');
    return perLanguage((lang) => ACTION_TEXTS.noUsableSupply[lang](list));
  }
  return { ...ACTION_TEXTS.noSupply };
}

/**
 * Where the supplies of the test answer come from, for support: nothing for
 * IPP alone, " (via SNMP)" for the fallback, " (+ SNMP: Imaging Unit)" naming
 * the parts the SNMP complement added after the IPP ones.
 * @param {{ supplySource?: string, markers: Array<{ name: string, source?: string }> }} printer
 * @returns {{ en: string, fr: string, de: string, es: string }}
 */
export function supplySourceText(printer) {
  if (printer.supplySource === 'snmp') {
    return { ...ACTION_TEXTS.viaSnmp };
  }
  if (printer.supplySource === 'ipp+snmp') {
    const names = printer.markers
      .filter((m) => m.source === 'snmp')
      .map((m) => m.name)
      .join(', ');
    return perLanguage((lang) => ACTION_TEXTS.plusSnmp[lang](names));
  }
  return perLanguage(() => '');
}

export const ACTIONS = {
  /**
   * Probe one printer typed by the user and report what it answers: the
   * quickest way to check a host/URI before adding it to the manual list,
   * and the diagnostic tool when a supply level does not show up.
   */
  async test_printer(_gladys, { fields }) {
    const target = String(fields?.host ?? '').trim();
    logger.info(`Action test_printer <- "${target}"`);
    const { url, attributes } = await probePrinter(target);
    // Same path as a real poll, SNMP fallback included: what the button
    // reports is exactly what the device will get.
    const printer = await withFallbackSupplies(parsePrinter(attributes), url, {
      ignoreBackoff: true,
    });

    const model = printer.makeAndModel ?? printer.name ?? url;
    // Naming the source matters for support: "via SNMP" tells the user their
    // printer needs SNMP reachable, and tells us which path answered.
    const via = supplySourceText(printer);
    const noSupply = noSupplyDiagnostic(attributes);

    return perLanguage((lang) => {
      const supplies = formatSupplies(printer, lang);
      return (
        ACTION_TEXTS.printerOk[lang](model, printer.stateText) +
        (supplies ? ` — ${supplies}${via[lang]}` : ` — ${noSupply[lang]}`) +
        ` (${url})`
      );
    });
  },
};
