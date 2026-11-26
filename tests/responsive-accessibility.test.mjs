import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('visible controls keep a 44 px touch-target floor', () => {
  assert.match(CSS, /button,\s*\ninput:not\(\[type="hidden"\]\),\s*\nselect,\s*\ntextarea,\s*\nsummary \{\s*min-height: 44px;/);
  assert.match(CSS, /button,\s*\nsummary \{\s*min-width: 44px;/);
  assert.match(CSS, /\.finding-refs button \{\s*min-width: 44px;\s*min-height: 44px;/);
  assert.match(CSS, /#reasoning-panel input\[type="range"\] \{[^}]*height: 44px;/);
  assert.doesNotMatch(CSS, /min-height: 34px;/);
});

test('mobile bill table headers leave table layout before visual clipping', () => {
  const group = /\.table-wrap table,\s*\n\s*\.table-wrap thead,\s*\n\s*\.table-wrap tbody,\s*\n\s*\.table-wrap tr,\s*\n\s*\.table-wrap th,\s*\n\s*\.table-wrap td \{\s*display: block;/;
  assert.match(CSS, group);
});

