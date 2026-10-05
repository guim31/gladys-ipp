// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTIONS } from '../src/actions.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { WIDGET } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

test('every manifest action has a registered handler', () => {
  const handled = new Set(Object.keys(ACTIONS));
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
});

test('every registered handler is declared in the manifest', () => {
  const declared = new Set((manifest.actions ?? []).map((a) => a.key));
  for (const key of Object.keys(ACTIONS)) {
    assert.ok(declared.has(key), `handler "${key}" is not declared in the manifest`);
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every non-section config field has a DEFAULT_CONFIG entry', () => {
  for (const field of manifest.config_schema) {
    if (field.type !== 'section') {
      assert.ok(
        field.key in DEFAULT_CONFIG,
        `DEFAULT_CONFIG must provide a default for "${field.key}"`,
      );
    }
  }
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest declares the mDNS capture the discovery code relies on', () => {
  const mdns = (manifest.network_discovery ?? []).filter((entry) => entry.type === 'mdns');
  assert.equal(mdns.length, 1);
  assert.equal(mdns[0].service, '_ipp._tcp');
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // The store vocabulary itself is checked by the store validator (unknown
  // keys are dropped with a warning there) — what this test pins is the
  // coupling rule: older cores reject any unknown manifest field, so a
  // manifest declaring `categories` must not claim compatibility below the
  // first release that accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('docker and cover images point at this repository', () => {
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-ipp:/);
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/guim31\/gladys-ipp\//,
  );
});

test('the manifest version matches package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'docker_image tag must match the manifest version',
  );
});

// --- Dashboard widgets --------------------------------------------------------

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every declared widget has a handler, and every handler a declaration', () => {
  assert.deepEqual(
    manifest.widgets.map((w) => w.key).sort(),
    Object.values(WIDGET).sort(),
    'manifest widgets and WIDGET constants must match',
  );
  for (const [name, key] of Object.entries(WIDGET)) {
    assert.ok(indexSource.includes(`onWidgetGet(WIDGET.${name}`), `widget "${key}" has no handler`);
  }
});

test('widget declarations fit the store and core constraints', () => {
  assert.match(manifest.gladys_version, />=\s*5\.1\.0/, 'widgets need Gladys 5.1');
  assert.ok(manifest.widgets.length >= 1 && manifest.widgets.length <= 5);
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
    for (const lang of ['en', 'fr']) {
      const label = widget.label[lang];
      assert.ok(label.length >= 3 && label.length <= 30, `label.${lang} of "${widget.key}"`);
      const description = widget.description?.[lang] ?? '';
      assert.ok(description.length <= 100, `description.${lang} of "${widget.key}"`);
    }
    assert.match(widget.icon, /^[a-z0-9-]{1,40}$/);
    for (const setting of widget.settings ?? []) {
      assert.ok(['string', 'number', 'boolean', 'select', 'section'].includes(setting.type));
      if (setting.source !== undefined) {
        assert.equal(setting.source, 'devices', 'the only dynamic source is the device list');
      }
      assert.ok(setting.label?.en && setting.label?.fr, `setting "${setting.key}" labels`);
    }
  }
});

test('the printer widget declares its button timeout and its device setting', () => {
  const printer = manifest.widgets.find((w) => w.key === WIDGET.PRINTER);
  assert.ok(printer.action_timeout_seconds >= 5 && printer.action_timeout_seconds <= 120);
  assert.ok(
    indexSource.includes(`onWidgetAction(WIDGET.PRINTER`),
    'the check button needs a handler',
  );
  const setting = printer.settings.find((s) => s.key === 'printer');
  assert.equal(setting.type, 'select');
  assert.equal(setting.source, 'devices');
  assert.equal(setting.required, false, 'empty = the first printer');
  const supplies = manifest.widgets.find((w) => w.key === WIDGET.SUPPLIES);
  assert.equal(supplies.settings, undefined);
  assert.equal(supplies.action_timeout_seconds, undefined, 'no button, no timeout');
});
