// -----------------------------------------------------------------------------
// Manifest actions: buttons rendered in the Configuration screen.
// Each key here matches an entry of the `actions` field of
// `gladys-assistant-integration.json`; index.js registers them all.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { probePrinter } from './ipp/client.js';
import { parsePrinter } from './printer.js';

const logger = createLogger({ name: 'actions' });

export const ACTIONS = {
  /**
   * Probe one printer typed by the user and report what it answers: the
   * quickest way to check a host/URI before adding it to the manual list.
   */
  async test_printer(_gladys, { fields }) {
    const target = String(fields?.host ?? '').trim();
    logger.info(`Action test_printer <- "${target}"`);
    const { url, attributes } = await probePrinter(target);
    const printer = parsePrinter(attributes);

    const model = printer.makeAndModel ?? printer.name ?? url;
    const supplies = printer.markers
      .filter((marker) => marker.percent !== null)
      .map((marker) => `${marker.name}: ${marker.percent}%`)
      .join(', ');

    return {
      en:
        `Printer OK: ${model} — state "${printer.stateText}"` +
        (supplies ? ` — ${supplies}` : ' — no supply level reported') +
        ` (${url})`,
      fr:
        `Imprimante OK : ${model} — état « ${printer.stateText} »` +
        (supplies ? ` — ${supplies}` : ' — aucun niveau de consommable annoncé') +
        ` (${url})`,
    };
  },
};
