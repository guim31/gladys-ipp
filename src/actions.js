// -----------------------------------------------------------------------------
// Manifest actions: buttons rendered in the Configuration screen.
// Each key here matches an entry of the `actions` field of
// `gladys-assistant-integration.json`; index.js registers them all.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { probePrinter } from './ipp/client.js';
import { parsePrinter } from './printer.js';

const logger = createLogger({ name: 'actions' });

// Human-readable meaning of the IPP marker-levels sentinels (RFC 3805
// semantics carried over IPP: negative values flag a non-numeric answer).
const RAW_LEVEL_TEXT = {
  en: { '-1': 'not reported (-1)', '-2': 'unknown (-2)', '-3': 'some left (-3)' },
  fr: { '-1': 'non communiqué (-1)', '-2': 'inconnu (-2)', '-3': 'il en reste (-3)' },
};

/**
 * Format the supplies of a parsed printer for the test action, in one
 * language. Unlike the device features, this shows EVERY supply the printer
 * announces — including the ones without a usable percentage, with the raw
 * IPP value explained. That is the diagnostic users paste on the forum when
 * a cartridge is missing from their device.
 * @param {{ markers: Array<{ name: string, percent: number|null, rawLevel: number|null }> }} printer
 * @param {'en'|'fr'} lang
 * @returns {string} e.g. "Black: unknown (-2), Cyan: 50%"
 */
export function formatSupplies(printer, lang) {
  return printer.markers
    .map((marker) => {
      if (marker.percent !== null) {
        return `${marker.name}: ${marker.percent}%`;
      }
      const raw =
        RAW_LEVEL_TEXT[lang][String(marker.rawLevel)] ??
        (marker.rawLevel === null
          ? lang === 'fr'
            ? 'valeur absente de marker-levels'
            : 'missing from marker-levels'
          : `${marker.rawLevel}`);
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
 * @returns {{ en: string, fr: string }}
 */
export function noSupplyDiagnostic(attributes) {
  const supplyKeys = Object.keys(attributes).filter((key) => /marker|supply|ink|toner/i.test(key));
  if (supplyKeys.length > 0) {
    const list = supplyKeys.join(', ');
    return {
      en: `no usable supply (unexploited attributes: ${list})`,
      fr: `aucun consommable exploitable (attributs non exploités : ${list})`,
    };
  }
  return {
    en: 'no supply attribute in the IPP answer',
    fr: 'aucun attribut de consommable dans la réponse IPP',
  };
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
    const printer = parsePrinter(attributes);

    const model = printer.makeAndModel ?? printer.name ?? url;
    const suppliesEn = formatSupplies(printer, 'en');
    const suppliesFr = formatSupplies(printer, 'fr');

    const noSupply = noSupplyDiagnostic(attributes);

    return {
      en:
        `Printer OK: ${model} — state "${printer.stateText}"` +
        (suppliesEn ? ` — ${suppliesEn}` : ` — ${noSupply.en}`) +
        ` (${url})`,
      fr:
        `Imprimante OK : ${model} — état « ${printer.stateText} »` +
        (suppliesFr ? ` — ${suppliesFr}` : ` — ${noSupply.fr}`) +
        ` (${url})`,
    };
  },
};
