// -----------------------------------------------------------------------------
// Translations: every multi-language text, in the manifest and in the code,
// carries exactly English, French, German and Spanish, none empty, each within
// the bound Gladys enforces where it is shown. Gladys shows the language of the
// user and falls back to English: a missing language would silently show
// English to a German or Spanish user.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTION_TEXTS, LANGUAGES as ACTION_LANGUAGES, RAW_LEVEL_TEXT } from '../src/actions.js';
import {
  NAME_LANGUAGES,
  NAMING_TEXTS,
  displayMarkerName,
  displayStateName,
  shortMarkerName,
} from '../src/naming.js';
import { STATUS_TEXTS } from '../src/status.js';
import { LANGUAGES, WIDGET_TEXTS } from '../src/widgets.js';

const EXPECTED = ['de', 'en', 'es', 'fr'];
const LANGUAGE_KEY = /^[a-z]{2}(-[A-Z]{2})?$/;

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/**
 * Every object of a tree whose keys look like languages, with its path.
 * An object counts as multi-language as soon as ONE of its keys is a
 * language code: a half-translated object is caught, never skipped.
 */
function multiLanguageObjects(node, path = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => multiLanguageObjects(item, `${path}[${index}]`, found));
  } else if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.some((key) => LANGUAGE_KEY.test(key))) {
      found.push({ path, value: node });
    } else {
      for (const key of keys) {
        multiLanguageObjects(node[key], `${path}.${key}`, found);
      }
    }
  }
  return found;
}

/** Bound of a manifest text, from its path (store schema and core limits). */
function manifestBound(path) {
  if (path === '$.description') {
    return 100;
  }
  if (/^\$\.widgets\[\d+\]\.label$/.test(path)) {
    return 30;
  }
  if (/^\$\.widgets\[\d+\]\.description$/.test(path)) {
    return 100;
  }
  if (/^\$\.config_schema\[\d+\]\.description$/.test(path)) {
    return 1000;
  }
  return 200;
}

function assertTranslated(value, path, max) {
  assert.deepEqual(Object.keys(value).sort(), EXPECTED, `${path}: languages`);
  for (const lang of EXPECTED) {
    const text = value[lang];
    assert.equal(typeof text, 'string', `${path}.${lang} must be a string`);
    assert.ok(text.trim().length > 0, `${path}.${lang} is empty`);
    assert.ok(text.length <= max, `${path}.${lang} is ${text.length} long (max ${max}): "${text}"`);
  }
}

test('the code and the tests agree on the four languages', () => {
  for (const list of [LANGUAGES, ACTION_LANGUAGES, NAME_LANGUAGES]) {
    assert.deepEqual([...list].sort(), EXPECTED);
  }
});

test('manifest: every multi-language object has exactly en, fr, de, es', () => {
  const objects = multiLanguageObjects(manifest);
  // The manifest holds 23 of them today: losing some would mean the walk
  // stopped seeing them, not that they were translated.
  assert.ok(objects.length >= 23, `only ${objects.length} multi-language objects found`);
  for (const { path, value } of objects) {
    assertTranslated(value, path, manifestBound(path));
  }
});

test('manifest: the sensor names can be picked in each of the four languages', () => {
  const field = manifest.config_schema.find((f) => f.key === 'feature_names');
  const values = field.options.map((option) => option.value);
  assert.deepEqual(values, ['printer', 'fr', 'en', 'de', 'es']);
});

test('widgets: every text is translated and fits its component', () => {
  // Status labels and values hold 40, a value tile label and a button 24,
  // a text component 300.
  const bounds = {
    state: 40,
    lastReading: 40,
    lowest: 40,
    toWatch: 24,
    check: 24,
    noPrinter: 300,
    missingPrinter: 300,
    waiting: 40,
    noLevel: 40,
  };
  for (const [key, max] of Object.entries(bounds)) {
    assertTranslated(WIDGET_TEXTS[key], `TEXTS.${key}`, max);
  }
  // Nothing else at the top level: a new text needs a bound here.
  assert.deepEqual(
    Object.keys(WIDGET_TEXTS).sort(),
    [...Object.keys(bounds), 'reasons', 'states'].sort(),
  );
  const objects = multiLanguageObjects({
    states: WIDGET_TEXTS.states,
    reasons: WIDGET_TEXTS.reasons,
  });
  assert.equal(objects.length, 4 + 16);
  for (const { path, value } of objects) {
    // States and reasons share the 40 of the State row: "Bereit (…)".
    assertTranslated(value, path, 40);
  }
});

test('connection statuses are translated', () => {
  for (const [key, value] of Object.entries(STATUS_TEXTS)) {
    assertTranslated(value, `STATUS_TEXTS.${key}`, 200);
  }
});

test('test action: every message is translated', () => {
  for (const [lang, texts] of Object.entries(RAW_LEVEL_TEXT)) {
    assert.deepEqual(Object.keys(texts).sort(), ['-1', '-2', '-3', 'missing'], lang);
  }
  assert.deepEqual(Object.keys(RAW_LEVEL_TEXT).sort(), EXPECTED);
  for (const [key, value] of Object.entries(ACTION_TEXTS)) {
    const rendered = Object.fromEntries(
      Object.entries(value).map(([lang, text]) => [
        lang,
        typeof text === 'function' ? text('X', 'Y') : text,
      ]),
    );
    assertTranslated(rendered, `ACTION_TEXTS.${key}`, 200);
  }
});

test('names: every table carries the four languages', () => {
  const { colors, shortColors, waste, state, roller, parts, rollerKinds } = NAMING_TEXTS;
  for (const color of colors) {
    for (const key of ['en', 'frM', 'frF', 'de', 'esM', 'esF']) {
      assert.ok(color[key]?.trim(), `color ${color.en}: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(shortColors)) {
    assertTranslated(value, `SHORT_COLORS.${key}`, 24);
  }
  for (const [key, value] of Object.entries(waste)) {
    assertTranslated(value, `WASTE_NAMES.${key}`, key === 'short' ? 24 : 60);
  }
  assertTranslated(state, 'STATE_NAMES', 24);
  assertTranslated(roller, 'ROLLER_NAMES', 24);
  for (const part of parts) {
    assertTranslated(part.short, `part ${part.long.en} (short)`, 24);
    assertTranslated(part.long, `part ${part.long.en} (long)`, 60);
  }
  for (const kind of rollerKinds) {
    assertTranslated(kind.short, `roller ${kind.long.en} (short)`, 24);
    assertTranslated(kind.long, `roller ${kind.long.en} (long)`, 60);
  }
});

test('names: German and Spanish feature names and tiles are built and fit', () => {
  const markers = [
    { name: 'Light Magenta Cleaning Unit', type: 'cleaner-unit' },
    { name: 'Photo Black Developer', type: 'developer' },
    { name: 'Transfer Belt', type: 'transfer-unit' },
    { name: 'Separation Roller MP Tray', type: 'other' },
    { name: 'Feed Roller Cassette 12', type: 'other' },
    { name: 'Maintenance Box', type: 'waste-ink' },
  ];
  for (const lang of ['de', 'es']) {
    for (const marker of markers) {
      const long = displayMarkerName(marker, lang);
      const short = shortMarkerName(marker, lang);
      assert.notEqual(long, marker.name, `${marker.name} (${lang}) is not translated`);
      assert.ok(short.length <= 24, `"${short}" (${lang}) passes the tile bound`);
    }
    assert.notEqual(displayStateName(lang), 'State');
  }
});

// German addresses the user informally ("du", like most of the Gladys
// interface and every integration of the maintainer): no polite "Sie" nor
// "Ihr…". Third-person plural "sie"/"ihr…" stays lowercase mid-sentence; a
// capitalized one is rephrased rather than allowed.
const POLITE = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/;

function germanTexts() {
  const texts = multiLanguageObjects(manifest).map(({ path, value }) => [path, value.de]);
  const tables = { WIDGET_TEXTS, STATUS_TEXTS };
  for (const [name, table] of Object.entries(tables)) {
    for (const { path, value } of multiLanguageObjects(table)) {
      texts.push([`${name}${path.slice(1)}`, value.de]);
    }
  }
  for (const [key, value] of Object.entries(ACTION_TEXTS)) {
    texts.push([
      `ACTION_TEXTS.${key}`,
      typeof value.de === 'function' ? value.de('X', 'Y') : value.de,
    ]);
  }
  for (const [key, text] of Object.entries(RAW_LEVEL_TEXT.de)) {
    texts.push([`RAW_LEVEL_TEXT.de.${key}`, text]);
  }
  // The name tables hold keys like `id` that pass for a language code: walk
  // them by hand.
  const { colors, shortColors, waste, state, roller, parts, rollerKinds } = NAMING_TEXTS;
  const names = [
    ...colors.map((color) => color.de),
    ...Object.values(shortColors).map((value) => value.de),
    ...Object.values(waste).map((value) => value.de),
    state.de,
    roller.de,
    ...[...parts, ...rollerKinds].flatMap((entry) => [entry.short.de, entry.long.de]),
  ];
  names.forEach((text, index) => texts.push([`NAMING_TEXTS[${index}]`, text]));
  return texts;
}

test('German says "du", never the polite "Sie"', () => {
  const texts = germanTexts();
  assert.ok(texts.length > 50, `only ${texts.length} German texts found`);
  for (const [path, text] of texts) {
    assert.doesNotMatch(text, POLITE, `${path}: "${text}"`);
  }
});
