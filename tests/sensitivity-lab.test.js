import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CASES, CATALOG, LOCALITIES } from '../src/data.js';
import { calculateReference } from '../src/engine.js';
import { canonical, sha256 } from '../src/exchange.js';
import {
  addDays, BOUNDARY_DAYS, BOUNDARY_GAPS, briefCsv, briefFor, briefJson, briefMarkdown,
  buildBrief, caseSummaries, COPY, DAY_RANGE, decodeLabHash, DEFAULT_LAB_STATE, encodeLabHash,
  fplRows, fplScreen, GAP_RANGE, GFE, gfeBoundaries, gfePoint, HASH_PREFIX, LAB_COMPONENTS,
  LAB_REGIONS, LAB_SCHEMA, LAB_SETTINGS, mutateBriefText, normalizeLabState, pfsCell,
  pfsComparison, selfTests, sha256Bytes, sha256Hex, verifyBriefDoc,
} from '../src/sensitivity-lab.js';

const nodeDigest = (value, encoding = 'utf8') => createHash('sha256').update(value, encoding).digest('hex');

// Pure-JS SHA-256 against node:crypto and the Web Crypto path in exchange.js.
for (const [value, expected] of [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
  ['é', '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'],
  ['a'.repeat(56), 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
  ['a'.repeat(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
  ['a'.repeat(119), '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb'],
  ['a'.repeat(120), '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c'],
]) {
  test(`SHA-256 vector ${JSON.stringify(value.slice(0, 24))} (${value.length}b)`, () => assert.equal(sha256Hex(value), expected));
}
test('SHA-256 million-a vector', () => assert.equal(sha256Hex('a'.repeat(1_000_000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'));

function generator(seed) {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
}
const random = generator(0x5e1a7);
for (let i = 0; i < 24; i++) {
  test(`SHA-256 parity with node:crypto on seeded input ${i}`, () => {
    const length = random() % 300;
    let value = '';
    for (let j = 0; j < length; j++) value += String.fromCodePoint(random() % 0x2fff);
    assert.equal(sha256Hex(value), nodeDigest(value));
  });
}
for (let i = 0; i < 8; i++) {
  test(`SHA-256 byte-level parity ${i}`, () => {
    const bytes = new Uint8Array(1 + (random() % 200));
    for (let j = 0; j < bytes.length; j++) bytes[j] = random() % 256;
    assert.equal(sha256Bytes(bytes), createHash('sha256').update(bytes).digest('hex'));
  });
}
for (const value of ['', 'clearbill-sensitivity-v1', JSON.stringify({ a: 1, b: 'x' }), 'é'.repeat(40)]) {
  test(`SHA-256 parity with Web Crypto ${JSON.stringify(value.slice(0, 20))}`, async () => {
    assert.equal(sha256Hex(value), await sha256(value));
  });
}
for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
  test(`SHA-256 padding boundary ${length}`, () => assert.equal(sha256Hex('x'.repeat(length)), nodeDigest('x'.repeat(length))));
}

// Strict bookmark codec.
test('codec encodes the full documented state', () => {
  const hash = encodeLabHash({ code: '70551', component: 'TC', setting: 'facility', region: 'hawaii', size: 8, income: 6407000, gap: 40000, days: 120 });
  assert.equal(hash, '#cbl=v1.c.70551.k.TC.s.facility.r.hawaii.h.8.i.6407000.g.40000.d.120');
});
const codes = Object.keys(CATALOG);
codes.forEach((code, index) => {
  const state = {
    code,
    component: LAB_COMPONENTS[index % 3],
    setting: LAB_SETTINGS[index % 2],
    region: LAB_REGIONS[index % 3],
    size: (index % 8) + 1,
    income: (index * 9973) % 90000000,
    gap: GAP_RANGE[0] + ((index * 31337) % (GAP_RANGE[1] - GAP_RANGE[0])),
    days: (index * 137) % 3651,
  };
  test(`codec round trip ${code}`, () => {
    const normalized = normalizeLabState(state);
    const hash = encodeLabHash(state);
    assert(hash.startsWith(`${HASH_PREFIX}.`));
    assert.deepEqual(decodeLabHash(hash), normalized);
    assert.equal(encodeLabHash(decodeLabHash(hash)), hash);
  });
});
for (const bad of [
  '', '#', '#cbl=', '#cbl=v1', '#cbl=v1.', '#cbl=v2.c.99213', 'cbl=v1.c.99213', ' #cbl=v1.c.99213',
  '#CBL=V1.C.99213', '#cbl=v1.c.99213 ', '#cbl=v1.x.1', '#cbl=v1.c', '#cbl=v1.c.', '#cbl=v1..c.99213',
  '#cbl=v1.c.99213.', '#cbl=v1.c.99213.c.99282', '#cbl=v1.c.__proto__', '#cbl=v1.constructor.x',
  '#cbl=v1.c.toString', '#cbl=v1.c.99213;evil=1', '#cbl=v1.c.99213%20', '#cbl=v1.h.0', '#cbl=v1.h.9',
  '#cbl=v1.h.-1', '#cbl=v1.h.1.5', '#cbl=v1.i.-1', '#cbl=v1.i.100000001', '#cbl=v1.g.-200001',
  '#cbl=v1.g.2000001', '#cbl=v1.g.1e3', '#cbl=v1.g.4.5', '#cbl=v1.g.+40000', '#cbl=v1.d.-1',
  '#cbl=v1.d.3651', '#cbl=v1.d.0x10', '#cbl=v1.s.Office', '#cbl=v1.r.texas', '#cbl=v1.k.base2',
  '#sealed=v1.AAAAAAAAAAAAAAAA.BBBBBB', `#cbl=v1.${'c.99213.'.repeat(40)}x.1`,
]) {
  test(`codec rejects ${JSON.stringify(bad.slice(0, 44))}`, () => assert.equal(decodeLabHash(bad), null));
}
for (const ok of [
  ['#cbl=v1.c.99213', code => code.code === '99213' && code.size === 3],
  ['#cbl=v1.s.facility.c.70551', code => code.setting === 'facility' && code.code === '70551'],
  ['#cbl=v1.g.-200000', code => code.gap === -200000],
  ['#cbl=v1.d.3650', code => code.days === 3650],
  ['#cbl=v1.i.0', code => code.income === 0],
  ['#cbl=v1.h.8', code => code.size === 8],
]) {
  test(`codec accepts ${ok[0]}`, () => {
    const decoded = decodeLabHash(ok[0]);
    assert(decoded && ok[1](decoded));
  });
}
test('codec survives a seeded hostile fuzz without throwing', () => {
  const alphabet = 'abcdksrhigv0123456789.=+#-_|';
  for (let i = 0; i < 120; i++) {
    let value = '#cbl=v1.';
    const length = random() % 40;
    for (let j = 0; j < length; j++) value += alphabet[random() % alphabet.length];
    const result = decodeLabHash(value);
    assert(result === null || normalizeLabState(result) !== null);
  }
});

// State normalizer hostile inputs.
for (const [label, input] of [
  ['null', null], ['undefined', undefined], ['number', 7], ['string', 'x'], ['boolean', true],
  ['array', []], ['proto literal', { __proto__: {} }], ['proto own key', JSON.parse('{"__proto__":{}}')],
  ['constructor', { constructor: 'x' }], ['prototype', { prototype: 'x' }], ['unknown key', { zoom: 1 }],
  ['NaN size', { size: NaN }], ['Infinity size', { size: Infinity }], ['float size', { size: 1.5 }],
  ['string size', { size: '3' }], ['negative size', { size: -1 }], ['zero size', { size: 0 }],
  ['negative income', { income: -1 }], ['float gap', { gap: 4.5 }], ['float days', { days: 1.2 }],
  ['NaN gap', { gap: NaN }], ['unknown code', { code: '99999' }], ['code toString', { code: 'toString' }],
  ['office case', { setting: 'Office' }], ['bad region', { region: 'texas' }], ['bad component', { component: 'global' }],
  ['null proto', Object.create(null)],
]) {
  test(`normalize rejects ${label}`, () => assert.equal(normalizeLabState(input), null));
}
for (const [patch, key, expected] of [
  [{ size: 8 }, 'size', 8], [{ income: 0 }, 'income', 0], [{ gap: -200000 }, 'gap', -200000],
  [{ days: 0 }, 'days', 0], [{ code: 'G2211' }, 'code', 'G2211'], [{ component: '26' }, 'component', '26'],
]) {
  test(`normalize merges ${JSON.stringify(patch)}`, () => {
    const result = normalizeLabState(patch);
    assert.equal(result[key], expected);
    for (const other of Object.keys(DEFAULT_LAB_STATE)) {
      if (other !== key) assert.equal(result[other], DEFAULT_LAB_STATE[other]);
    }
  });
}
test('normalize keeps -0 harmless: encodes as 0, no negative zero in hash', () => {
  const result = normalizeLabState({ gap: -0, days: -0 });
  assert.equal(encodeLabHash(result).includes('g.0'), true);
  assert.equal(encodeLabHash(result).includes('g.-'), false);
  assert.equal(String(result.gap), '0');
});
test('sealed fragments and foreign schemas never decode as lab state', () => {
  assert.equal(decodeLabHash('#sealed=v1.AAAA.BBBB'), null);
  assert.equal(decodeLabHash('#other=v1.c.99213'), null);
});
test('normalize output carries no input prototype or extras', () => {
  const result = normalizeLabState({ code: '99213' });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(DEFAULT_LAB_STATE).sort());
});

// Scaled-integer PFS parity across every catalog row, locality and setting.
for (const code of codes) {
  for (const component of LAB_COMPONENTS) {
    for (const locality of Object.keys(LOCALITIES)) {
      for (const setting of LAB_SETTINGS) {
        test(`lab PFS parity ${code} ${component} ${locality} ${setting}`, () => {
          const cell = pfsCell(code, locality, setting, component);
          const result = calculateReference(code, locality, setting, component);
          assert.equal(cell.available, result.available);
          if (cell.available) {
            assert.equal(cell.cents, result.cents);
            assert.deepEqual(cell.products, result.products);
            assert(cell.work + cell.pe + cell.mp >= cell.cents - 1 && cell.work + cell.pe + cell.mp <= cell.cents + 1);
            assert(cell.cents > 0);
          } else {
            assert.equal(cell.reason, result.reason);
            assert(!('cents' in cell));
          }
        });
      }
    }
  }
}
for (const [code, locality, setting, component] of [
  ['99999', 'iowa', 'office', 'base'], ['99213', 'texas', 'office', 'base'], ['99213', 'iowa', 'clinic', 'base'],
  ['99213', 'iowa', 'office', 'global'], [null, 'iowa', 'office', 'base'], ['__proto__', 'iowa', 'office', 'base'],
  [undefined, 'houston', 'facility', 'TC'],
]) {
  test(`pfsCell hostile input ${JSON.stringify([code, locality, setting, component])}`, () => {
    assert.deepEqual(pfsCell(code, locality, setting, component), { available: false, reason: 'invalid' });
  });
}
for (const [code, component, office, facility] of [
  ['99213', 'base', 10763 - 8923, 6378 - 5470],
  ['99284', 'base', null, 13338 - 10991],
  ['70551', '26', 7521 - 6474, 7521 - 6474],
  ['45385', 'base', 57364 - 46135, 25227 - 20830],
  ['80053', 'base', null, null],
]) {
  test(`spread ${code} ${component}`, () => {
    const result = pfsComparison({ code, component });
    assert.equal(result.spread.office, office);
    assert.equal(result.spread.facility, facility);
    assert.equal(result.localities.length, 3);
  });
}
test('comparison rows keep MAC identifiers and N/A order stable', () => {
  const { localities } = pfsComparison({ code: '71046' });
  assert.deepEqual(localities.map(row => row.mac), ['04412 / 18', '13202 / 01', '05102 / 00']);
  assert.equal(localities[0].cells.office.available, true);
  assert.equal(localities[0].cells.facility.status, undefined);
  assert.equal(localities[0].cells.facility.reason, 'setting-not-applicable');
});

// GFE boundary sweep.
const baseGfe = { initialBill: GFE.initialBill, checkedOn: null };
for (const gap of [-200000, -65001, -1, 0, 1, 39998, 39999, 40000, 40001, 47500, 100000, 2000000]) {
  test(`GFE point at ${gap} cents`, () => {
    const point = gfePoint({ gap, days: 12 });
    assert.equal(point.gap, gap);
    const billed = GFE.estimated + gap;
    const expected = billed < 0 || billed > 32 * 100_000_000 ? 'unavailable' : gap >= 40000 ? 'potential-ppdr' : 'below-threshold';
    assert.equal(point.state, expected);
  });
}
for (const [days, expected] of [[0, 'potential-ppdr'], [1, 'potential-ppdr'], [118, 'potential-ppdr'], [119, 'potential-ppdr'], [120, 'potential-ppdr'], [121, 'outside-window'], [200, 'outside-window'], [3650, 'outside-window']]) {
  test(`GFE window at ${days} days`, () => {
    const point = gfePoint({ gap: 47500, days });
    assert.equal(point.state, expected);
    assert.equal(point.elapsed, days);
  });
}
test('GFE matrix is a deterministic 3x3', () => {
  const { gaps, days, matrix } = gfeBoundaries();
  assert.deepEqual(gaps, [...BOUNDARY_GAPS]);
  assert.deepEqual(days, [...BOUNDARY_DAYS]);
  assert.equal(matrix.length, 3);
  assert(matrix.every(row => row.length === 3));
  assert.deepEqual(matrix[0], ['below-threshold', 'below-threshold', 'below-threshold']);
  assert.deepEqual(matrix[1], ['potential-ppdr', 'potential-ppdr', 'outside-window']);
  assert.deepEqual(matrix[2], ['potential-ppdr', 'potential-ppdr', 'outside-window']);
});
for (const [day, count, expected] of [
  ['2026-10-29', 0, '2026-10-29'], ['2026-10-29', 12, '2026-11-10'], ['2026-10-29', 120, '2027-02-26'],
  ['2026-12-31', 1, '2027-01-01'], ['2024-02-28', 1, '2024-02-29'], ['2026-02-28', 1, '2026-03-01'],
  ['2026-10-29', 3650, '2036-10-26'],
]) {
  test(`addDays ${day} + ${count}`, () => assert.equal(addDays(day, count), expected));
}
for (const [day, count] of [['not-a-date', 1], ['2026-10-29', 1.5], ['2026-10-29', NaN], ['', 0]]) {
  test(`addDays rejects ${JSON.stringify([day, count])}`, () => assert.equal(addDays(day, count), null));
}

// 2026 HHS poverty guideline sweeps (published values in cents).
const published = {
  contiguous: [1596000, 2164000, 2732000, 3300000, 3868000, 4436000, 5004000, 5572000],
  alaska: [1995000, 2705000, 3415000, 4125000, 4835000, 5545000, 6255000, 6965000],
  hawaii: [1836000, 2489000, 3142000, 3795000, 4448000, 5101000, 5754000, 6407000],
};
for (const region of LAB_REGIONS) {
  published[region].forEach((guideline, index) => {
    test(`FPL row ${region} size ${index + 1}`, () => {
      const row = fplRows(region)[index];
      assert.deepEqual(row, { size: index + 1, guideline, at200: guideline * 2, at400: guideline * 4 });
    });
  });
}
test('FPL rows fall back to contiguous on hostile region', () => {
  assert.equal(fplRows('texas')[0].guideline, 1596000);
  assert.equal(fplRows('__proto__')[7].guideline, 5572000);
  assert.equal(fplRows('contiguous').length, 8);
});
for (const [region, size, income, band] of [
  ['contiguous', 3, 2732000, 'at-or-below-200'], ['contiguous', 3, 5464000, 'at-or-below-200'],
  ['contiguous', 3, 5464001, 'at-or-below-400'], ['contiguous', 3, 10928000, 'at-or-below-400'],
  ['contiguous', 3, 10928001, 'above-400'], ['alaska', 1, 1995000, 'at-or-below-200'],
  ['alaska', 1, 7980000, 'at-or-below-400'], ['hawaii', 8, 6407000, 'at-or-below-200'],
  ['hawaii', 8, 12814000, 'at-or-below-200'], ['hawaii', 8, 12814001, 'at-or-below-400'],
]) {
  test(`FPL band ${region} ${size} ${income}`, () => assert.equal(fplScreen({ region, size, income }).band, band));
}

// Case replay comparator.
test('case comparator reproduces the documented flag counts', () => {
  const summaries = caseSummaries();
  assert.deepEqual(summaries.map(row => row.id), Object.keys(CASES));
  assert.deepEqual(summaries.map(row => row.review), [4, 1, 0]);
  assert(summaries.every(row => row.matched === 4 && row.checks === 4));
  assert.deepEqual(summaries[0].kinds, ['exact-duplicate', 'near-duplicate', 'ptp-pair-review', 'mue-units']);
  assert.deepEqual(summaries[1].kinds, ['gfe-threshold']);
  assert.deepEqual(summaries[2].kinds, []);
  assert.equal(summaries[1].estimate, 'potential-ppdr');
  assert.equal(summaries[0].estimate, 'none');
});
test('modifier-evidence probes are deterministic', () => {
  const [er, imaging, clean] = caseSummaries();
  assert.deepEqual(er.probes, { documented: 1, plain: 4 });
  assert.deepEqual(imaging.probes, { documented: 1, plain: 1 });
  assert.deepEqual(clean.probes, { documented: 0, plain: 0 });
});

// Audited brief exporter.
test('brief payload is canonical JSON safe and deterministic', () => {
  for (const state of [DEFAULT_LAB_STATE, { code: '80053' }, { gap: -200000, days: 3650, income: 0, size: 8, region: 'hawaii' }]) {
    const brief = buildBrief(state);
    assert.equal(brief.payload.schema, LAB_SCHEMA);
    assert.equal(brief.payload.ruleVersion, 'clearbill-2026q4-v1');
    assert.equal(canonical(brief.payload), brief.canonical);
    assert.equal(brief.sha256, nodeDigest(brief.canonical));
    assert.equal(sha256Hex(brief.canonical), nodeDigest(brief.canonical));
    assert.equal(briefFor(state).sha256, brief.sha256);
  }
});
test('one cached digest-stamped payload per state key', () => {
  const a = briefFor({ code: '99213', days: 12 });
  const b = briefFor({ days: 12, code: '99213' });
  assert.equal(a, b);
  const c = briefFor({ code: '99213', days: 13 });
  assert.notEqual(a, c);
  assert.notEqual(a.sha256, c.sha256);
});
test('JSON, CSV and Markdown share one digest', () => {
  const brief = briefFor({ code: '74177', component: '26', setting: 'facility', region: 'alaska', size: 5, income: 50000, gap: 40001, days: 121 });
  assert.match(briefJson(brief), new RegExp(`"sha256": "${brief.sha256}"`));
  assert.match(briefCsv(brief), new RegExp(`"sha256","${brief.sha256}"`));
  const md = briefMarkdown(brief);
  assert(md.split(brief.sha256).length >= 3);
  assert.match(md, /clearbill-2026q4-v1/);
});
test('JSON verifies and single-digit tamper is caught', () => {
  const brief = briefFor({ code: '99285' });
  const doc = briefJson(brief);
  assert.deepEqual(verifyBriefDoc(doc), { ok: true, sha256: brief.sha256 });
  const mutated = mutateBriefText(doc);
  assert.notEqual(mutated, doc);
  const result = verifyBriefDoc(mutated);
  assert.equal(result.ok, false);
  const swapped = doc.replace('"days": 12', '"days": 13');
  const replay = verifyBriefDoc(swapped);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /digest mismatch/);
});
for (const [label, mutate] of [
  ['digit bump', text => mutateBriefText(text)],
  ['truncation', text => text.slice(0, -20)],
  ['value edit', text => text.replace('"gap": 47500', '"gap": 47501')],
  ['schema swap', text => text.replace('clearbill-sensitivity-v1', 'clearbill-sensitivity-v9')],
  ['ruleset swap', text => text.replace('clearbill-2026q4-v1', 'clearbill-2026q4-v2')],
  ['digest flip', text => {
    const current = text.match(/"sha256": "([a-f0-9])/)[1];
    return text.replace(`"sha256": "${current}`, `"sha256": "${current === 'f' ? 'e' : 'f'}`);
  }],
]) {
  test(`brief rejects ${label}`, () => assert.equal(verifyBriefDoc(mutate(briefJson(briefFor({ code: '99281' })))).ok, false));
}
for (const input of ['', 'x', '{}', '[]', 'null', '{"payload":{},"sha256":"abc"}', '{"payload":1,"sha256":"' + '0'.repeat(64) + '"}', '"str"', '0'.repeat(300 * 1024)]) {
  test(`brief doc rejects malformed ${JSON.stringify(input.slice(0, 30))}`, () => assert.equal(verifyBriefDoc(input).ok, false));
}
test('CSV layout, escaping and N/A rows', () => {
  const csv = briefCsv(briefFor({ code: '80053' }));
  const lines = csv.trimEnd().split('\r\n');
  assert(csv.endsWith('\r\n'));
  assert(lines.some(line => line === '"section","pfs"'));
  const pfs = lines.filter(line => line.startsWith('"pfs",'));
  assert.equal(pfs.length, 7);
  const pattern = /^("(?:[^"]|"")*"|-?\d+)(,("(?:[^"]|"")*"|-?\d+))*$/;
  assert(lines.every(line => pattern.test(line)));
  assert(!/(^|,)[ \t]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(csv.replace(/"[^"\r\n]*"/g, '')));
  assert(csv.includes('"N/A"') || csv.includes('N/A'));
  assert(!csv.includes('$0.00'));
});
test('Markdown keeps tables, digests and no N/A-as-zero rows', () => {
  const md = briefMarkdown(briefFor({ code: '99284' }), 'en');
  assert(md.startsWith('# ClearBill sensitivity brief'));
  assert(md.includes('| Houston, TX | 04412 / 18 | Facility professional |'));
  assert(!md.includes('N/A | N/A | N/A | $0'));
  const mdEs = briefMarkdown(briefFor({ code: '99284' }), 'es');
  assert(mdEs.includes('Informe de sensibilidad'));
});
test('mutateBriefText handles edge inputs', () => {
  assert.equal(mutateBriefText('no digits'), 'no digits0');
  assert.equal(mutateBriefText(''), '0');
  assert.equal(mutateBriefText('9'), '0');
  assert.equal(mutateBriefText('a1b'), 'a2b');
});

// In-page deterministic self-tests mirror the exported surface.
test('selfTests pass and cover the promised checks', () => {
  const tests = selfTests();
  assert(tests.length >= 14);
  const ids = new Set(tests.map(item => item.id));
  assert.equal(ids.size, tests.length);
  for (const item of tests) assert.doesNotThrow(() => item.run(), item.id);
});
test('selfTest ids have EN and ES names', () => {
  for (const item of selfTests()) {
    assert(COPY.en.tests[item.id], item.id);
    assert(COPY.es.tests[item.id], item.id);
  }
});
test('COPY locales mirror each other', () => {
  for (const key of ['strings', 'settings', 'components', 'regions', 'caseNames', 'states', 'table', 'gfe', 'fpl', 'bands', 'cases', 'chart', 'status', 'md', 'tests']) {
    assert.deepEqual(Object.keys(COPY.es[key]).sort(), Object.keys(COPY.en[key]).sort(), key);
  }
  assert(COPY.en.title && COPY.es.title);
});
test('defaults stay inside every documented range', () => {
  assert(normalizeLabState(DEFAULT_LAB_STATE));
  const { gap, days, size, income } = DEFAULT_LAB_STATE;
  assert(gap >= GAP_RANGE[0] && gap <= GAP_RANGE[1]);
  assert(days >= DAY_RANGE[0] && days <= DAY_RANGE[1]);
  assert(size >= 1 && size <= 8 && income >= 0);
});
