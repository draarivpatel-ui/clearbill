// Sensitivity lab: deterministic fictional comparisons, digest-stamped exports and a strict bookmark codec.
import { CASES, CATALOG, CONVERSION_1E4, DISTINCT_MODIFIERS, LOCALITIES, RULESET } from './data.js';
import { audit, calculateReference, compareEstimate, MAX_CENTS, parseDollars, screenFpl, usd } from './engine.js';
import { canonical, csvCell } from './exchange.js';
import { createCase } from './fixtures.js';

// Pure-JS SHA-256 (FIPS 180-4) so the self-test runner and exporter work without Web Crypto.
const SHA256_INITIAL = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const utf8 = new TextEncoder();
const rotr = (word, bits) => ((word >>> bits) | (word << (32 - bits))) >>> 0;

export function sha256Bytes(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : utf8.encode(String(bytes));
  const buffer = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  buffer.set(input);
  buffer[input.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bitLength = input.length * 8;
  view.setUint32(buffer.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(buffer.length - 4, bitLength >>> 0);
  const h = new Uint32Array(SHA256_INITIAL);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map(word => word.toString(16).padStart(8, '0')).join('');
}

export function sha256Hex(text) {
  return sha256Bytes(utf8.encode(String(text)));
}

export const LAB_SCHEMA = 'clearbill-sensitivity-v1';
export const HASH_PREFIX = '#cbl=v1';
export const LAB_SETTINGS = Object.freeze(['office', 'facility']);
export const LAB_COMPONENTS = Object.freeze(['base', '26', 'TC']);
export const LAB_REGIONS = Object.freeze(['contiguous', 'alaska', 'hawaii']);
export const HOUSEHOLD_RANGE = Object.freeze([1, 8]);
export const BOUNDARY_GAPS = Object.freeze([39999, 40000, 40001]);
export const BOUNDARY_DAYS = Object.freeze([119, 120, 121]);
export const GAP_RANGE = Object.freeze([-200000, 2000000]);
export const DAY_RANGE = Object.freeze([0, 3650]);
// Fixed fictional self-pay fixture values from demo-imaging, kept constant for replay.
export const GFE = Object.freeze({
  fixture: 'demo-imaging', estimated: 65000, threshold: 40000, window: 120,
  initialBill: '2026-10-29', serviceDay: '2026-10-21',
});
export const DEFAULT_LAB_STATE = Object.freeze({
  code: '99213', component: 'base', setting: 'office', region: 'contiguous',
  size: 3, income: 4000000, gap: 47500, days: 12,
});

const intIn = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value + 0 : undefined);
const pickIn = (value, list) => (typeof value === 'string' && list.includes(value) ? value : undefined);
const VALIDATORS = Object.freeze({
  code: value => (typeof value === 'string' && Object.hasOwn(CATALOG, value) ? value : undefined),
  component: value => pickIn(value, LAB_COMPONENTS),
  setting: value => pickIn(value, LAB_SETTINGS),
  region: value => pickIn(value, LAB_REGIONS),
  size: value => intIn(value, HOUSEHOLD_RANGE[0], HOUSEHOLD_RANGE[1]),
  income: value => intIn(value, 0, MAX_CENTS),
  gap: value => intIn(value, GAP_RANGE[0], GAP_RANGE[1]),
  days: value => intIn(value, DAY_RANGE[0], DAY_RANGE[1]),
});
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function normalizeLabState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return null;
  const out = { ...DEFAULT_LAB_STATE };
  for (const key of Object.keys(input)) {
    if (BLOCKED_KEYS.has(key) || !Object.hasOwn(VALIDATORS, key)) return null;
    const value = VALIDATORS[key](input[key]);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

const HASH_KEYS = Object.freeze({ c: 'code', k: 'component', s: 'setting', r: 'region', h: 'size', i: 'income', g: 'gap', d: 'days' });
const NUMERIC_FIELDS = new Set(['size', 'income', 'gap', 'days']);
const HASH_PATTERN = /^#cbl=v1(?:\.[cksrhigd]\.[A-Za-z0-9-]+)+$/;
const INT_PATTERN = /^-?\d+$/;

export function decodeLabHash(hash) {
  if (typeof hash !== 'string' || hash.length > 220 || !HASH_PATTERN.test(hash)) return null;
  const tokens = hash.slice(HASH_PREFIX.length + 1).split('.');
  if (tokens.length % 2) return null;
  const candidate = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = HASH_KEYS[tokens[i]];
    if (!key || Object.hasOwn(candidate, key)) return null;
    if (NUMERIC_FIELDS.has(key) && !INT_PATTERN.test(tokens[i + 1])) return null;
    candidate[key] = NUMERIC_FIELDS.has(key) ? Number(tokens[i + 1]) : tokens[i + 1];
  }
  return normalizeLabState(candidate);
}

const SHORT_KEYS = Object.freeze({ code: 'c', component: 'k', setting: 's', region: 'r', size: 'h', income: 'i', gap: 'g', days: 'd' });
export function encodeLabHash(input) {
  const state = normalizeLabState(input);
  if (!state) return null;
  return `${HASH_PREFIX}.${['code', 'component', 'setting', 'region', 'size', 'income', 'gap', 'days']
    .map(key => `${SHORT_KEYS[key]}.${state[key]}`).join('.')}`;
}

// One scaled-integer cent contribution per component, rounded half up like the published sum.
const pricedCents = product => Number((BigInt(product) * BigInt(CONVERSION_1E4) + 5_000_000n) / 10_000_000n);

export function pfsCell(code, locality, setting, component) {
  const known = typeof code === 'string' && Object.hasOwn(CATALOG, code)
    && typeof locality === 'string' && Object.hasOwn(LOCALITIES, locality)
    && LAB_SETTINGS.includes(setting) && LAB_COMPONENTS.includes(component);
  if (!known) return { available: false, reason: 'invalid' };
  const result = calculateReference(code, locality, setting, component);
  if (!result.available) return { available: false, reason: result.reason };
  const [work, pe, mp] = result.products.map(pricedCents);
  return { available: true, cents: result.cents, work, pe, mp, products: [...result.products], rvu: [...result.rvu], gpci: [...result.gpci] };
}

export function pfsComparison(input) {
  const state = normalizeLabState(input) || { ...DEFAULT_LAB_STATE };
  const localities = Object.keys(LOCALITIES).map(key => ({
    key,
    name: LOCALITIES[key].name,
    mac: LOCALITIES[key].mac,
    cells: Object.fromEntries(LAB_SETTINGS.map(setting => [setting, pfsCell(state.code, key, setting, state.component)])),
  }));
  const spread = Object.fromEntries(LAB_SETTINGS.map(setting => {
    const amounts = localities.map(row => row.cells[setting]).filter(cell => cell.available).map(cell => cell.cents);
    return [setting, amounts.length >= 2 ? Math.max(...amounts) - Math.min(...amounts) : null];
  }));
  return { code: state.code, component: state.component, name: CATALOG[state.code].name, localities, spread };
}

const dayMs = 86_400_000;
export function addDays(day, count) {
  const base = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(base) || !Number.isInteger(count)) return null;
  return new Date(base + count * dayMs).toISOString().slice(0, 10);
}

export function gfePoint(input) {
  const state = normalizeLabState(input) || { ...DEFAULT_LAB_STATE };
  const checkedOn = addDays(GFE.initialBill, state.days);
  const result = compareEstimate({
    estimated: GFE.estimated, billed: GFE.estimated + state.gap,
    election: true, estimateBeforeCare: true,
    initialBill: GFE.initialBill, checkedOn, serviceDay: GFE.serviceDay,
  });
  return {
    gap: state.gap, days: state.days, checkedOn,
    state: result.state, meetsAmount: result.meetsAmount ?? null, elapsed: result.elapsed ?? null,
  };
}

export function gfeBoundaries() {
  return {
    gaps: [...BOUNDARY_GAPS],
    days: [...BOUNDARY_DAYS],
    matrix: BOUNDARY_GAPS.map(gap => BOUNDARY_DAYS.map(days => gfePoint({ gap, days }).state)),
  };
}

export function fplRows(region) {
  const safe = LAB_REGIONS.includes(region) ? region : 'contiguous';
  return Array.from({ length: HOUSEHOLD_RANGE[1] }, (_, index) => {
    const size = index + 1;
    const guideline = screenFpl(safe, size, 0).guideline;
    return { size, guideline, at200: guideline * 2, at400: guideline * 4 };
  });
}

export function fplScreen(input) {
  const state = normalizeLabState(input) || { ...DEFAULT_LAB_STATE };
  const result = screenFpl(state.region, state.size, state.income);
  return { region: state.region, size: state.size, income: state.income, ...result };
}

function mappedCase(id, map) {
  const snapshot = createCase(id);
  return { ...snapshot, lines: snapshot.lines.map(map) };
}

export function caseSummaries() {
  return Object.keys(CASES).map(id => {
    const report = audit(createCase(id));
    const documented = audit(mappedCase(id, line => ({
      ...line, modifiers: [...new Set([...line.modifiers, '59'])], evidence: 'encounter',
    }))).reviewCount;
    const plain = audit(mappedCase(id, line => ({
      ...line, modifiers: line.modifiers.filter(modifier => !DISTINCT_MODIFIERS.includes(modifier)), evidence: 'none',
    }))).reviewCount;
    return {
      id, name: CASES[id].name, review: report.reviewCount,
      kinds: [...new Set(report.findings.map(row => row.kind))],
      matched: report.balances.filter(row => row.matches).length, checks: report.balances.length,
      estimate: report.estimate ? report.estimate.state : 'none',
      probes: { documented, plain },
    };
  });
}

const briefCache = new Map();

export function buildBrief(input) {
  const state = normalizeLabState(input) || { ...DEFAULT_LAB_STATE };
  const comparison = pfsComparison(state);
  const payload = {
    schema: LAB_SCHEMA,
    ruleVersion: RULESET,
    educational: true,
    note: 'Fictional educational data only. Not billing, medical or legal advice.',
    state,
    pfs: {
      code: comparison.code, component: comparison.component, name: comparison.name,
      rows: comparison.localities.flatMap(loc => LAB_SETTINGS.map(setting => {
        const cell = loc.cells[setting];
        return cell.available
          ? { locality: loc.key, mac: loc.mac, setting, status: 'available', work: cell.work, pe: cell.pe, mp: cell.mp, cents: cell.cents }
          : { locality: loc.key, mac: loc.mac, setting, status: cell.reason };
      })),
      spread: LAB_SETTINGS.map(setting => ({ setting, cents: comparison.spread[setting] })),
    },
    gfe: { ...GFE, point: gfePoint(state), boundary: gfeBoundaries() },
    fpl: { ...fplScreen(state), rows: fplRows(state.region) },
    cases: caseSummaries(),
  };
  const text = canonical(payload);
  return { payload, canonical: text, sha256: sha256Hex(text) };
}

// One canonical digest-stamped payload per state key, reused by the page, JSON, CSV and Markdown.
export function briefFor(input) {
  const state = normalizeLabState(input) || { ...DEFAULT_LAB_STATE };
  const key = canonical(state);
  if (!briefCache.has(key)) {
    if (briefCache.size >= 200) briefCache.clear();
    briefCache.set(key, buildBrief(state));
  }
  return briefCache.get(key);
}

export function briefJson(brief) {
  return `${JSON.stringify({ payload: brief.payload, sha256: brief.sha256 }, null, 2)}\n`;
}

export function briefCsv(brief) {
  const { payload } = brief;
  const rows = [
    ['provenance', 'schema', payload.schema],
    ['provenance', 'ruleset', payload.ruleVersion],
    ['provenance', 'sha256', brief.sha256],
    ['provenance', 'share', encodeLabHash(payload.state)],
    ['provenance', 'note', payload.note],
    ['section', 'pfs'],
    ['pfs', 'code', 'component', 'locality', 'mac', 'setting', 'work_cents', 'pe_cents', 'mp_cents', 'total_cents'],
    ...payload.pfs.rows.map(row => (row.status === 'available'
      ? ['pfs', payload.pfs.code, payload.pfs.component, row.locality, row.mac, row.setting, row.work, row.pe, row.mp, row.cents]
      : ['pfs', payload.pfs.code, payload.pfs.component, row.locality, row.mac, row.setting, 'N/A', 'N/A', 'N/A', 'N/A'])),
    ...payload.pfs.spread.map(row => ['pfs-spread', row.setting, row.cents === null ? 'N/A' : row.cents]),
    ['section', 'gfe-boundary'],
    ['gfe', 'gap_cents', 'days', 'state'],
    ...payload.gfe.boundary.gaps.flatMap((gap, gi) => payload.gfe.boundary.days.map((days, di) => ['gfe', gap, days, payload.gfe.boundary.matrix[gi][di]])),
    ['gfe-point', payload.gfe.point.gap, payload.gfe.point.days, payload.gfe.point.state],
    ['section', 'fpl'],
    ['fpl', 'region', 'size', 'guideline_cents', 'band_200_cents', 'band_400_cents'],
    ...payload.fpl.rows.map(row => ['fpl', payload.fpl.region, row.size, row.guideline, row.at200, row.at400]),
    ['fpl-point', payload.fpl.region, payload.fpl.size, payload.fpl.income, payload.fpl.percentTenths, payload.fpl.band],
    ['section', 'cases'],
    ['case', 'id', 'review_flags', 'checks_matched', 'checks_total', 'estimate_state', 'kinds', 'documented_probe', 'plain_probe'],
    ...payload.cases.map(row => ['case', row.id, row.review, row.matched, row.checks, row.estimate, row.kinds.join(' '), row.probes.documented, row.probes.plain]),
  ];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const money = value => (value === null || value === undefined ? 'N/A' : usd(value));
export function briefMarkdown(brief, language = 'en') {
  const { payload } = brief;
  const words = COPY[language] || COPY.en;
  const lines = [
    `# ${words.md.title}`, '',
    payload.note, '',
    `- Ruleset \`${payload.ruleVersion}\``,
    `- SHA-256 \`${brief.sha256}\``,
    `- Share \`${encodeLabHash(payload.state)}\``, '',
    `## ${words.md.pfs}`, '',
    `| ${words.table.locality} | MAC | ${words.table.setting} | ${words.table.work} | ${words.table.pe} | ${words.table.mp} | ${words.table.total} |`,
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...payload.pfs.rows.map(row => (row.status === 'available'
      ? `| ${LOCALITIES[row.locality].name} | ${row.mac} | ${words.settings[row.setting]} | ${money(row.work)} | ${money(row.pe)} | ${money(row.mp)} | ${money(row.cents)} |`
      : `| ${LOCALITIES[row.locality].name} | ${row.mac} | ${words.settings[row.setting]} | N/A | N/A | N/A | N/A |`)),
    '',
    ...payload.pfs.spread.map(row => `- ${words.md.spread} ${words.settings[row.setting]}: ${money(row.cents)}`),
    '',
    `## ${words.md.gfe}`, '',
    `| ${words.gfe.gap} | ${BOUNDARY_DAYS.map(day => `${day} ${words.gfe.dayUnit}`).join(' | ')} |`,
    `| --- | ${BOUNDARY_DAYS.map(() => '---').join(' | ')} |`,
    ...payload.gfe.boundary.gaps.map((gap, gi) => `| ${money(gap)} | ${payload.gfe.boundary.matrix[gi].map(state => words.states[state] || state).join(' | ')} |`),
    '',
    `- ${words.gfe.point}: ${money(payload.gfe.point.gap)} / ${payload.gfe.point.days} ${words.gfe.dayUnit} = ${words.states[payload.gfe.point.state] || payload.gfe.point.state}`,
    '',
    `## ${words.md.fpl}`, '',
    `| ${words.fpl.size} | ${words.fpl.guideline} | ${words.fpl.band200} | ${words.fpl.band400} |`,
    '| ---: | ---: | ---: | ---: |',
    ...payload.fpl.rows.map(row => `| ${row.size} | ${money(row.guideline)} | ${money(row.at200)} | ${money(row.at400)} |`),
    '',
    `- ${words.fpl.income}: ${words.regions[payload.fpl.region]} / ${payload.fpl.size} / ${money(payload.fpl.income)} = ${(payload.fpl.percentTenths / 10).toFixed(1)}% (${payload.fpl.band})`,
    '',
    `## ${words.md.cases}`, '',
    `| ${words.cases.head} | ${words.cases.flags} | ${words.cases.checks} | ${words.cases.estimate} | ${words.cases.kinds} |`,
    '| --- | ---: | --- | --- | --- |',
    ...payload.cases.map(row => `| ${words.caseNames[row.id]} | ${row.review} | ${row.matched}/${row.checks} | ${row.estimate} | ${row.kinds.join(', ') || 'none'} |`),
    '',
    `SHA-256 \`${brief.sha256}\` ${words.md.footer}`,
    '',
  ];
  return lines.join('\n');
}

const MAX_DOC_BYTES = 256 * 1024;
export function verifyBriefDoc(text) {
  if (typeof text !== 'string' || text.length > MAX_DOC_BYTES || utf8.encode(text).length > MAX_DOC_BYTES) {
    return { ok: false, reason: 'Document exceeds the size limit or is not text.' };
  }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || !Object.hasOwn(doc, 'payload') || !Object.hasOwn(doc, 'sha256')
      || typeof doc.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(doc.sha256)
      || !doc.payload || typeof doc.payload !== 'object'
      || doc.payload.schema !== LAB_SCHEMA || doc.payload.ruleVersion !== RULESET) {
      return { ok: false, reason: 'Unknown or incomplete sensitivity document.' };
    }
    const actual = sha256Hex(canonical(doc.payload));
    return actual === doc.sha256 ? { ok: true, sha256: actual } : { ok: false, reason: 'SHA-256 digest mismatch.' };
  } catch {
    return { ok: false, reason: 'Invalid sensitivity document JSON.' };
  }
}

export function mutateBriefText(text) {
  const chars = [...String(text)];
  const index = chars.findIndex(char => /[0-9]/.test(char));
  if (index < 0) return `${text}0`;
  chars[index] = String((Number(chars[index]) + 1) % 10);
  return chars.join('');
}

const check = (condition, detail) => {
  if (!condition) throw new Error(detail);
};

export function selfTests() {
  const priced = Object.entries(CATALOG).flatMap(([code, entry]) => Object.keys(entry.rows).map(component => ({ code, component })));
  return [
    ['digest-vectors', () => {
      check(sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty vector');
      check(sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc vector');
      check(sha256Hex('The quick brown fox jumps over the lazy dog') === 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592', 'fox vector');
      check(sha256Hex('a'.repeat(1_000_000)) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', 'million-a vector');
    }],
    ['digest-utf8', () => {
      check(sha256Hex('é') === '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c', 'utf8 vector');
      check(sha256Hex('a'.repeat(56)) === 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a', '56-byte boundary');
      check(sha256Hex('a'.repeat(119)) === '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb', '119-byte boundary');
    }],
    ['pfs-parity', () => {
      for (const { code, component } of priced) for (const locality of Object.keys(LOCALITIES)) for (const setting of LAB_SETTINGS) {
        const cell = pfsCell(code, locality, setting, component);
        const result = calculateReference(code, locality, setting, component);
        check(cell.available === result.available, `${code}/${component}/${locality}/${setting} availability`);
        if (cell.available) check(cell.cents === result.cents, `${code}/${component}/${locality}/${setting} cents`);
      }
    }],
    ['pfs-na', () => {
      for (const code of Object.keys(CATALOG)) for (const locality of Object.keys(LOCALITIES)) for (const setting of LAB_SETTINGS) {
        const cell = pfsCell(code, locality, setting, 'base');
        if (!cell.available) check(!('cents' in cell) && cell.reason !== undefined, `${code} N/A carries no cents`);
        else check(cell.cents > 0, `${code} priced rows never show $0`);
      }
      check(pfsCell('80053', 'iowa', 'office', 'base').reason === 'not-listed', 'unpriced code reason');
      check(pfsCell('99284', 'iowa', 'office', 'base').reason === 'setting-not-applicable', 'NA setting reason');
      check(pfsCell('__proto__', 'iowa', 'office', 'base').available === false, 'hostile code rejected');
    }],
    ['spread', () => {
      const result = pfsComparison({ code: '99213', component: 'base' });
      check(result.spread.office === 10763 - 8923, 'office spread 1840');
      check(result.spread.facility === 6378 - 5470, 'facility spread 908');
      check(pfsComparison({ code: '80053' }).spread.office === null, 'unpriced spread stays null');
    }],
    ['gfe-gap', () => {
      check(gfePoint({ gap: 39999, days: 12 }).state === 'below-threshold', 'gap 39999 below');
      check(gfePoint({ gap: 40000, days: 12 }).state === 'potential-ppdr', 'gap 40000 inclusive');
      check(gfePoint({ gap: 40000, days: 12 }).meetsAmount === true, 'gap 40000 meetsAmount');
    }],
    ['gfe-days', () => {
      check(gfePoint({ gap: 47500, days: 120 }).state === 'potential-ppdr', 'day 120 inclusive');
      check(gfePoint({ gap: 47500, days: 121 }).state === 'outside-window', 'day 121 outside');
      check(gfePoint({ gap: 47500, days: 12 }).checkedOn === '2026-11-10', 'checkedOn deterministic');
    }],
    ['gfe-matrix', () => {
      const { matrix } = gfeBoundaries();
      check(matrix[0].every(state => state === 'below-threshold'), 'row 39999 below');
      check(matrix[1][0] === 'potential-ppdr' && matrix[1][1] === 'potential-ppdr' && matrix[1][2] === 'outside-window', 'row 40000 boundary');
      check(matrix[2][0] === 'potential-ppdr' && matrix[2][2] === 'outside-window', 'row 40001 boundary');
    }],
    ['fpl-guidelines', () => {
      const rows = fplRows('contiguous');
      check(rows.length === 8 && rows[0].guideline === 1596000 && rows[0].at200 === 3192000 && rows[0].at400 === 6384000, 'contiguous size 1');
      check(rows[7].guideline === 5572000, 'contiguous size 8');
      check(fplRows('alaska')[0].guideline === 1995000 && fplRows('hawaii')[0].guideline === 1836000, 'alaska and hawaii');
    }],
    ['fpl-band', () => {
      check(fplScreen({ region: 'contiguous', size: 3, income: 2732000 }).band === 'at-or-below-200', '200% band inclusive');
      check(fplScreen({ region: 'contiguous', size: 3, income: 5464000 }).band === 'at-or-below-200', '200% boundary');
      check(fplScreen({ region: 'contiguous', size: 3, income: 5464001 }).band === 'at-or-below-400', '400% next cent');
      check(fplScreen({ region: 'contiguous', size: 3, income: 10928000 }).band === 'at-or-below-400', '400% boundary');
      check(fplScreen({ region: 'contiguous', size: 3, income: 10928001 }).band === 'above-400', 'above boundary');
    }],
    ['cases', () => {
      const summaries = caseSummaries();
      check(summaries.map(row => row.review).join(',') === '4,1,0', 'fictional flag counts');
      check(summaries.every(row => row.matched === 4 && row.checks === 4), 'four balance checks each');
      check(summaries[0].kinds.join(',') === 'exact-duplicate,near-duplicate,ptp-pair-review,mue-units', 'ER flag kinds');
      check(summaries[1].estimate === 'potential-ppdr' && summaries[0].estimate === 'none', 'estimate states');
    }],
    ['probe', () => {
      const [er, imaging, clean] = caseSummaries();
      check(er.probes.documented === 1 && er.probes.plain === 4, 'ER evidence sensitivity');
      check(imaging.probes.documented === 1 && clean.probes.documented === 0, 'probe counts on other cases');
    }],
    ['csv-safe', () => {
      check(csvCell('=CMD()') === `"'=CMD()"`, 'formula prefix neutralized');
      const csv = briefCsv(briefFor({ code: '70551' }));
      const linePattern = /^("(?:[^"]|"")*"|-?\d+)(,("(?:[^"]|"")*"|-?\d+))*$/;
      check(csv.trimEnd().split('\r\n').every(line => linePattern.test(line)), 'every cell quoted or integer');
    }],
    ['digest-parity', () => {
      const brief = briefFor({ code: '74177', component: '26', setting: 'facility', region: 'alaska', size: 5, income: 50000, gap: 40001, days: 121 });
      check(briefJson(brief).includes(`"sha256": "${brief.sha256}"`), 'JSON carries digest');
      check(briefCsv(brief).includes(`"sha256","${brief.sha256}"`), 'CSV carries digest');
      check(briefMarkdown(brief).split(brief.sha256).length - 1 >= 2, 'Markdown carries digest twice');
    }],
    ['tamper', () => {
      const brief = briefFor({ code: '99285' });
      check(verifyBriefDoc(briefJson(brief)).ok === true, 'clean document verifies');
      check(verifyBriefDoc(mutateBriefText(briefJson(brief))).ok === false, 'one-digit edit detected');
      check(verifyBriefDoc('{"payload":{},"sha256":"x"}').ok === false, 'malformed rejected');
    }],
    ['codec', () => {
      const state = { code: '70551', component: 'TC', setting: 'facility', region: 'hawaii', size: 8, income: 6407000, gap: 40000, days: 120 };
      const hash = encodeLabHash(state);
      check(hash === '#cbl=v1.c.70551.k.TC.s.facility.r.hawaii.h.8.i.6407000.g.40000.d.120', 'stable encoding');
      const restored = decodeLabHash(hash);
      check(JSON.stringify(restored) === JSON.stringify(normalizeLabState(state)), 'round trip');
      check(decodeLabHash('#cbl=v1.s.facility.c.70551') !== null, 'key order flexible');
    }],
    ['codec-malformed', () => {
      for (const bad of ['#cbl=v1.c.__proto__', '#cbl=v1.constructor.x', '#cbl=v2.c.99213', '#cbl=',
        '#cbl=v1.c.99213.c.99282', '#cbl=v1.h.9', '#cbl=v1.g.1e3', '#cbl=v1.z.1', '#cbl=v1.c',
        '#sealed=v1.AAAA.BBBB', 'cbl=v1.c.99213', '#cbl=v1.i.-5', '#cbl=v1.d.-1']) {
        check(decodeLabHash(bad) === null, `rejected ${bad}`);
      }
    }],
    ['cache', () => {
      const a = briefFor({ code: '99213', days: 12 });
      const b = briefFor({ days: 12, code: '99213' });
      check(a === b, 'one digest-stamped payload per state key');
      check(a.sha256 === buildBrief({ code: '99213', days: 12 }).sha256, 'deterministic digest');
      check(canonical({ b: 1, a: 2 }) === '{"a":2,"b":1}', 'canonical key order');
    }],
    ['hostile', () => {
      for (const bad of [null, 7, 'x', [], { size: NaN }, { size: Infinity }, { gap: -0.5 }, { days: 1.5 },
        { income: -1 }, { code: 'toString' }, { region: '__proto__' }, { __proto__: {} }, { extra: 1 }]) {
        check(normalizeLabState(bad) === null, `rejected ${JSON.stringify(bad)}`);
      }
      check(normalizeLabState({ size: 8 })?.size === 8, 'partial merge allowed');
    }],
  ].map(([id, run]) => ({ id, run }));
}

export const COPY = Object.freeze({
  en: {
    title: 'Sensitivity lab',
    strings: {
      code: 'Procedure code', component: 'Component', setting: 'Service setting', region: 'Region',
      size: 'Household size', income: 'Annual income', gap: 'Difference over estimate', days: 'Days since initial bill',
      chartTitle: 'Three-locality stacked breakdown', boundsTitle: 'Estimate and guideline boundaries',
      casesTitle: 'Fictional case replay', exportTitle: 'Audited sensitivity brief', exportJson: 'Export JSON',
      exportCsv: 'Export CSV', exportMd: 'Export Markdown', exportCopy: 'Copy share link',
      exportVerify: 'Verify digest', exportTamper: 'Tamper demo', linkLabel: 'Share link',
      testsTitle: 'Deterministic self-tests', testsRun: 'Run self-tests',
      note: 'Fictional educational figures. Clinician reference amounts are not hospital prices, insurer allowances or amounts owed. A flag is a question to ask, not a determination.',
      pfsTitle: 'Locality by setting comparison',
    },
    settings: { office: 'Office/non-facility', facility: 'Facility professional' },
    components: { base: 'Global (base)', 26: 'Professional (26)', TC: 'Technical (TC)' },
    regions: { contiguous: 'Contiguous states and DC', alaska: 'Alaska', hawaii: 'Hawaii' },
    caseNames: { 'demo-er': 'ER visit', 'demo-imaging': 'Outpatient imaging', 'demo-clean': 'Routine follow-up' },
    states: {
      'potential-ppdr': 'Meets both screens', 'below-threshold': 'Below $400', 'outside-window': 'Past 120 days',
      'missing-prerequisites': 'Missing prerequisite', unavailable: 'Unavailable', none: 'None',
    },
    table: {
      locality: 'Locality', mac: 'MAC', setting: 'Setting', work: 'Work', pe: 'Practice expense',
      mp: 'Malpractice', total: 'Per unit', spread: 'Locality spread', na: 'N/A',
    },
    pfsNote: 'Work, practice expense and malpractice columns round once per component. The per-unit total follows the published formula and rounds once on the sum, so a component can differ from the total by a cent. N/A marks rows the snapshot does not price, never $0.',
    gfe: {
      title: 'Good faith estimate boundary matrix', gap: 'Difference', dayUnit: 'days',
      point: 'Current estimate check', against: 'against a $650.00 fictional estimate',
    },
    fpl: {
      title: '2026 guideline examples', size: 'Size', guideline: 'Guideline',
      band200: '200% band', band400: '400% band', income: 'Income check',
    },
    bands: {
      'at-or-below-200': 'at or below the example 200% band',
      'at-or-below-400': 'between the example 200% and 400% bands',
      'above-400': 'above the example 400% band',
    },
    cases: {
      head: 'Case', flags: 'Review flags', checks: 'Balance checks', estimate: 'Estimate',
      kinds: 'Flag kinds', documented: 'With documented evidence', plain: 'No distinct modifiers',
    },
    chart: {
      legend: ['Work', 'Practice expense', 'Malpractice'], na: 'N/A',
      eligible: 'Meets both screens', gapAxis: 'Difference over estimate', daysAxis: 'Days since initial bill',
      threshold: '$400 screen', window: '120-day screen', current: 'Current point',
    },
    aria: {
      bar: (loc, setting, total) => `${loc} ${setting}: ${total}`,
      barNa: (loc, setting) => `${loc} ${setting}: not priced`,
      point: (gap, days, state) => `Estimate check ${gap}, ${days} days, ${state}`,
      labLanguage: 'Lab language',
    },
    status: {
      json: 'Sensitivity JSON downloaded. The digest detects edits; it does not authenticate a sender.',
      csv: 'Formula-safe CSV downloaded.',
      md: 'Markdown brief downloaded.',
      copied: 'Share link copied to the clipboard.',
      copyManual: 'Select the share link text and copy it.',
      verified: 'Digest verified. The payload matches the stamped fingerprint.',
      unexpected: 'The stamped digest did not match the payload. Export again before sharing.',
      tampered: 'Tamper detected. Flipping one digit inside the export breaks the digest.',
      invalid: 'Enter a household size of 1 to 8, a whole day count and dollar amounts without commas.',
      tests: (done, total) => `${done}/${total} passing`,
      restored: 'Share link state restored.',
    },
    md: {
      title: 'ClearBill sensitivity brief', pfs: 'Medicare locality comparison', spread: 'Locality spread',
      gfe: 'Estimate boundary matrix', fpl: '2026 guideline examples', cases: 'Fictional case replay',
      footer: 'covers the canonical JSON payload. It detects edits; it does not authenticate a sender.',
    },
    tests: {
      'digest-vectors': 'SHA-256 known vectors', 'digest-utf8': 'SHA-256 UTF-8 and padding boundaries',
      'pfs-parity': 'Scaled-integer PFS parity across localities', 'pfs-na': 'N/A preserved, never $0',
      spread: 'Exact locality spread', 'gfe-gap': '$400 amount screen boundary', 'gfe-days': '120-day window boundary',
      'gfe-matrix': 'Boundary matrix consistency', 'fpl-guidelines': '2026 HHS guideline thresholds',
      'fpl-band': 'Example band boundaries', cases: 'Fictional case flag counts',
      probe: 'Modifier-evidence sensitivity', 'csv-safe': 'CSV formula escaping', 'digest-parity': 'One digest across all exports',
      tamper: 'Tamper detection', codec: 'Bookmark codec round trip', 'codec-malformed': 'Malformed hashes rejected',
      cache: 'Digest cache determinism', hostile: 'Hostile state inputs rejected',
    },
  },
  es: {
    title: 'Laboratorio de sensibilidad',
    strings: {
      code: 'Código de procedimiento', component: 'Componente', setting: 'Entorno de servicio', region: 'Región',
      size: 'Tamaño del hogar', income: 'Ingreso anual', gap: 'Diferencia sobre el estimado', days: 'Días desde la factura inicial',
      chartTitle: 'Desglose por tres localidades', boundsTitle: 'Límites del estimado y de las guías',
      casesTitle: 'Revisión de casos ficticios', exportTitle: 'Informe de sensibilidad verificable', exportJson: 'Exportar JSON',
      exportCsv: 'Exportar CSV', exportMd: 'Exportar Markdown', exportCopy: 'Copiar enlace',
      exportVerify: 'Verificar huella', exportTamper: 'Prueba de alteración', linkLabel: 'Enlace para compartir',
      testsTitle: 'Pruebas internas deterministas', testsRun: 'Ejecutar pruebas',
      note: 'Cifras ficticias solo para aprender. Los montos de referencia clínicos no son precios de hospital, montos aprobados por seguros ni saldos a pagar. Una alerta es una pregunta, no una decisión.',
      pfsTitle: 'Comparación por localidad y entorno',
    },
    settings: { office: 'Consultorio/no institucional', facility: 'Profesional en institución' },
    components: { base: 'Global (base)', 26: 'Profesional (26)', TC: 'Técnico (TC)' },
    regions: { contiguous: 'Estados contiguos y DC', alaska: 'Alaska', hawaii: 'Hawái' },
    caseNames: { 'demo-er': 'Visita a urgencias', 'demo-imaging': 'Estudio de imagen ambulatorio', 'demo-clean': 'Consulta de seguimiento' },
    states: {
      'potential-ppdr': 'Cumple ambas pantallas', 'below-threshold': 'Bajo $400', 'outside-window': 'Más de 120 días',
      'missing-prerequisites': 'Falta un requisito', unavailable: 'No disponible', none: 'Ninguno',
    },
    table: {
      locality: 'Localidad', mac: 'MAC', setting: 'Entorno', work: 'Trabajo', pe: 'Gasto de práctica',
      mp: 'Responsabilidad', total: 'Por unidad', spread: 'Rango entre localidades', na: 'N/A',
    },
    pfsNote: 'Las columnas de trabajo, gasto de práctica y responsabilidad redondean una vez por componente. El total por unidad sigue la fórmula publicada y redondea una vez sobre la suma, así que un componente puede diferir del total por un centavo. N/A marca filas que el cuadro no valora, nunca $0.',
    gfe: {
      title: 'Matriz de límites del estimado de buena fe', gap: 'Diferencia', dayUnit: 'días',
      point: 'Revisión actual del estimado', against: 'frente a un estimado ficticio de $650.00',
    },
    fpl: {
      title: 'Ejemplos de guías 2026', size: 'Tamaño', guideline: 'Guía',
      band200: 'Banda 200%', band400: 'Banda 400%', income: 'Revisión de ingreso',
    },
    bands: {
      'at-or-below-200': 'en o bajo la banda de ejemplo 200%',
      'at-or-below-400': 'entre las bandas de ejemplo 200% y 400%',
      'above-400': 'sobre la banda de ejemplo 400%',
    },
    cases: {
      head: 'Caso', flags: 'Alertas', checks: 'Verificaciones', estimate: 'Estimado',
      kinds: 'Tipos', documented: 'Con evidencia documentada', plain: 'Sin modificadores distintos',
    },
    chart: {
      legend: ['Trabajo', 'Gasto de práctica', 'Responsabilidad'], na: 'N/A',
      eligible: 'Cumple ambas pantallas', gapAxis: 'Diferencia sobre el estimado', daysAxis: 'Días desde la factura inicial',
      threshold: 'Pantalla de $400', window: 'Pantalla de 120 días', current: 'Punto actual',
    },
    aria: {
      bar: (loc, setting, total) => `${loc} ${setting}: ${total}`,
      barNa: (loc, setting) => `${loc} ${setting}: sin precio`,
      point: (gap, days, state) => `Revisión del estimado ${gap}, ${days} días, ${state}`,
      labLanguage: 'Idioma del laboratorio',
    },
    status: {
      json: 'JSON de sensibilidad descargado. La huella detecta cambios; no autentica al remitente.',
      csv: 'CSV seguro para hojas de cálculo descargado.',
      md: 'Informe Markdown descargado.',
      copied: 'Enlace copiado al portapapeles.',
      copyManual: 'Seleccione el texto del enlace y cópielo.',
      verified: 'Huella verificada. El contenido coincide con la huella registrada.',
      unexpected: 'La huella registrada no coincide con el contenido. Exporte de nuevo antes de compartir.',
      tampered: 'Alteración detectada. Cambiar un dígito dentro del archivo rompe la huella.',
      invalid: 'Escriba un tamaño de hogar de 1 a 8, días enteros y montos sin comas.',
      tests: (done, total) => `${done}/${total} correctas`,
      restored: 'Estado del enlace restaurado.',
    },
    md: {
      title: 'Informe de sensibilidad de ClearBill', pfs: 'Comparación de localidades Medicare', spread: 'Rango entre localidades',
      gfe: 'Matriz de límites del estimado', fpl: 'Ejemplos de guías 2026', cases: 'Revisión de casos ficticios',
      footer: 'cubre el contenido JSON canónico. Detecta cambios; no autentica al remitente.',
    },
    tests: {
      'digest-vectors': 'Vectores conocidos de SHA-256', 'digest-utf8': 'SHA-256 con UTF-8 y bordes de relleno',
      'pfs-parity': 'Paridad PFS con enteros escalados', 'pfs-na': 'N/A se conserva, nunca $0',
      spread: 'Rango exacto entre localidades', 'gfe-gap': 'Límite de la pantalla de $400', 'gfe-days': 'Límite de 120 días',
      'gfe-matrix': 'Consistencia de la matriz', 'fpl-guidelines': 'Umbrales HHS 2026',
      'fpl-band': 'Límites de las bandas de ejemplo', cases: 'Conteo de alertas por caso',
      probe: 'Sensibilidad a la evidencia', 'csv-safe': 'Escape de fórmulas en CSV', 'digest-parity': 'Una sola huella en todas las exportaciones',
      tamper: 'Detección de alteración', codec: 'Ida y vuelta del enlace', 'codec-malformed': 'Enlaces mal formados rechazados',
      cache: 'Determinismo de la huella', hostile: 'Entradas hostiles rechazadas',
    },
  },
});

function parseSignedDollars(value) {
  if (typeof value !== 'string') return null;
  const negative = value.startsWith('-');
  const parsed = parseDollars(negative ? value.slice(1) : value);
  if (parsed === null) return null;
  return negative ? -parsed : parsed;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountSensitivityLab(panel) {
  const doc = panel?.ownerDocument;
  const win = doc?.defaultView;
  const $ = id => doc.getElementById(id);
  for (const id of ['lab-code', 'lab-component', 'lab-setting', 'lab-region', 'lab-size', 'lab-income', 'lab-gap',
    'lab-days', 'lab-pfs', 'lab-chart', 'lab-boundary', 'lab-quadrant', 'lab-cases', 'lab-status', 'lab-digest', 'lab-link']) {
    if (!doc || !$(id)) throw new Error('Sensitivity lab markup is missing.');
  }

  let state = { ...DEFAULT_LAB_STATE };
  let language = 'en';
  const words = () => COPY[language];
  const el = (tag, text = '', className = '') => {
    const node = doc.createElement(tag);
    if (text !== '') node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
  const status = key => { $('lab-status').textContent = words().status[key] || ''; };

  function cell(row, label, content, cls) {
    const td = el('td', '', cls);
    td.dataset.label = label;
    td.append(content);
    row.append(td);
    return td;
  }

  function buildSelects() {
    const w = words();
    $('lab-code').replaceChildren(...Object.keys(CATALOG).map(code => option(code, `${code} / ${CATALOG[code].name}`)));
    $('lab-component').replaceChildren(...LAB_COMPONENTS.map(key => {
      const button = el('button', w.components[key]);
      button.type = 'button';
      button.dataset.value = key;
      button.addEventListener('click', () => update({ component: key }));
      return button;
    }));
    $('lab-setting').replaceChildren(...LAB_SETTINGS.map(key => {
      const button = el('button', w.settings[key]);
      button.type = 'button';
      button.dataset.value = key;
      button.addEventListener('click', () => update({ setting: key }));
      return button;
    }));
    $('lab-region').replaceChildren(...LAB_REGIONS.map(key => {
      const button = el('button', w.regions[key]);
      button.type = 'button';
      button.dataset.value = key;
      button.addEventListener('click', () => update({ region: key }));
      return button;
    }));
  }

  function syncControls() {
    $('lab-code').value = state.code;
    for (const [id, value] of [['lab-component', state.component], ['lab-setting', state.setting], ['lab-region', state.region]]) {
      for (const button of $(id).querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
    }
    $('lab-size').value = state.size;
    $('lab-income').value = (state.income / 100).toFixed(2);
    $('lab-gap').value = (state.gap / 100).toFixed(2);
    $('lab-days').value = state.days;
  }

  function table(heads, rows, label) {
    const wrap = el('div', '', 'table-wrap lab-table');
    const node = el('table');
    node.setAttribute('role', 'table');
    node.setAttribute('aria-label', label);
    const head = node.createTHead().insertRow();
    head.parentElement.setAttribute('role', 'rowgroup');
    head.setAttribute('role', 'row');
    for (const text of heads) {
      const th = el('th', text);
      th.setAttribute('role', 'columnheader');
      th.scope = 'col';
      head.append(th);
    }
    const body = node.createTBody();
    body.setAttribute('role', 'rowgroup');
    for (const fill of rows) {
      const tr = body.insertRow();
      tr.setAttribute('role', 'row');
      fill(tr);
    }
    wrap.append(node);
    return wrap;
  }

  function renderPfs(brief) {
    const w = words();
    const { payload } = brief;
    const heads = [w.table.locality, w.table.mac, w.table.setting, w.table.work, w.table.pe, w.table.mp, w.table.total];
    const rows = payload.pfs.rows.map(row => tr => {
      cell(tr, heads[0], LOCALITIES[row.locality].name);
      cell(tr, heads[1], row.mac, 'money');
      cell(tr, heads[2], w.settings[row.setting]);
      if (row.status === 'available') {
        cell(tr, heads[3], usd(row.work), 'money');
        cell(tr, heads[4], usd(row.pe), 'money');
        cell(tr, heads[5], usd(row.mp), 'money');
        cell(tr, heads[6], usd(row.cents), 'money');
      } else {
        for (const head of heads.slice(3)) cell(tr, head, w.table.na, 'money rate-unavailable');
      }
    });
    const spreadLine = payload.pfs.spread
      .map(row => `${w.settings[row.setting]} ${w.table.spread.toLowerCase()}: ${money(row.cents)}`).join(' / ');
    $('lab-pfs').replaceChildren(
      el('h2', `${w.strings.pfsTitle}: ${payload.pfs.code} ${w.components[payload.pfs.component]}`, 'lab-subhead'),
      table(heads, rows, w.strings.pfsTitle),
      el('p', `${spreadLine}. ${w.pfsNote}`, 'ledger-note'));
  }

  function renderChart(brief) {
    const w = words();
    const cells = brief.payload.pfs.rows;
    const [W, H, left, right, top, bottom] = [640, 268, 56, 14, 30, 58];
    const plotH = H - top - bottom;
    const plotW = W - left - right;
    const maxCents = Math.max(1, ...cells.map(row => (row.status === 'available' ? row.cents : 0)));
    const y = value => top + plotH - (value / maxCents) * plotH;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': w.strings.chartTitle });
    const groupW = plotW / 3;
    const barW = Math.min(38, groupW / 2 - 10);
    // Legend
    w.chart.legend.forEach((label, i) => {
      const gx = left + i * 150;
      svg.append(svgEl('rect', { x: gx, y: 8, width: 10, height: 10, class: `seg-${['work', 'pe', 'mp'][i]}` }));
      const text = svgEl('text', { x: gx + 15, y: 17, class: 'chart-label' });
      text.textContent = label;
      svg.append(text);
    });
    // Gridlines
    for (const frac of [0, 0.5, 1]) {
      const value = Math.round(maxCents * frac);
      const gy = y(value);
      svg.append(svgEl('line', { x1: left, x2: W - right, y1: gy, y2: gy, class: 'chart-grid' }));
      const text = svgEl('text', { x: left - 6, y: gy + 3, 'text-anchor': 'end', class: 'chart-label chart-value' });
      text.textContent = usd(value);
      svg.append(text);
    }
    Object.keys(LOCALITIES).forEach((key, gi) => {
      const center = left + groupW * gi + groupW / 2;
      LAB_SETTINGS.forEach((setting, si) => {
        const row = cells[gi * 2 + si];
        const x = center + (si === 0 ? -barW - 5 : 5);
        const bar = svgEl('g', { class: 'chart-bar', tabindex: '0', role: 'img' });
        if (row.status === 'available') {
          bar.setAttribute('aria-label', w.aria.bar(LOCALITIES[key].name, w.settings[setting], usd(row.cents)));
          const title = svgEl('title');
          title.textContent = `${usd(row.cents)}`;
          bar.append(title);
          const parts = [['work', row.work], ['pe', row.pe], ['mp', row.mp]];
          let acc = 0;
          for (const [part, value] of parts) {
            const y1 = y(acc + value);
            const y0 = y(acc);
            bar.append(svgEl('rect', { x, y: y1, width: barW, height: Math.max(0, y0 - y1), class: `seg-${part}` }));
            acc += value;
          }
          const total = svgEl('text', { x: x + barW / 2, y: y(acc) - 6, 'text-anchor': 'middle', class: 'chart-label chart-value' });
          total.textContent = usd(row.cents);
          bar.append(total);
        } else {
          bar.setAttribute('aria-label', w.aria.barNa(LOCALITIES[key].name, w.settings[setting]));
          const title = svgEl('title');
          title.textContent = 'N/A';
          bar.append(title);
          const naH = plotH * 0.55;
          const naY = top + (plotH - naH) / 2;
          bar.append(svgEl('rect', { x, y: naY, width: barW, height: naH, class: 'bar-na' }));
          const text = svgEl('text', { x: x + barW / 2, y: naY + naH / 2 + 3, 'text-anchor': 'middle', class: 'chart-label' });
          text.textContent = 'N/A';
          bar.append(text);
        }
        bar.append(svgEl('rect', { x: x - 3, y: top - 4, width: barW + 6, height: plotH + 8, class: 'bar-ring' }));
        svg.append(bar);
        const setLabel = svgEl('text', { x: x + barW / 2, y: top + plotH + 14, 'text-anchor': 'middle', class: 'chart-label' });
        setLabel.textContent = w.settings[setting].split('/')[0].split(' ')[0];
        svg.append(setLabel);
      });
      const locLabel = svgEl('text', { x: center, y: top + plotH + 30, 'text-anchor': 'middle', class: 'chart-label chart-loc' });
      locLabel.textContent = LOCALITIES[key].name;
      svg.append(locLabel);
    });
    svg.append(svgEl('line', { x1: left, x2: W - right, y1: top + plotH, y2: top + plotH, class: 'chart-axis' }));
    $('lab-chart').replaceChildren(svg);
  }

  function renderBoundary(brief) {
    const w = words();
    const { payload } = brief;
    const dayHeads = payload.gfe.boundary.days.map(day => `${day} ${w.gfe.dayUnit}`);
    const matrix = table(
      [w.gfe.gap, ...dayHeads],
      payload.gfe.boundary.gaps.map((gap, gi) => tr => {
        cell(tr, w.gfe.gap, usd(gap), 'money');
        payload.gfe.boundary.days.forEach((day, di) => {
          const stateName = payload.gfe.boundary.matrix[gi][di];
          cell(tr, `${day} ${w.gfe.dayUnit}`, w.states[stateName] || stateName);
        });
      }),
      w.gfe.title);
    const point = el('p',
      `${w.gfe.point}: ${usd(payload.gfe.point.gap)} / ${payload.gfe.point.days} ${w.gfe.dayUnit} ${w.gfe.against} = ${w.states[payload.gfe.point.state] || payload.gfe.point.state}.`,
      'ledger-note');
    const rows = payload.fpl.rows.map(row => tr => {
      cell(tr, w.fpl.size, String(row.size), 'money');
      cell(tr, w.fpl.guideline, usd(row.guideline), 'money');
      cell(tr, w.fpl.band200, usd(row.at200), 'money');
      cell(tr, w.fpl.band400, usd(row.at400), 'money');
    });
    const income = el('p',
      `${w.fpl.income}: ${w.regions[payload.fpl.region]} / ${payload.fpl.size} / ${usd(payload.fpl.income)} = ${(payload.fpl.percentTenths / 10).toFixed(1)}%, ${w.bands[payload.fpl.band]}.`,
      'ledger-note');
    $('lab-boundary').replaceChildren(
      el('h2', w.gfe.title, 'lab-subhead'), matrix, point,
      el('h2', `${w.fpl.title} / ${w.regions[payload.fpl.region]}`, 'lab-subhead'),
      table([w.fpl.size, w.fpl.guideline, w.fpl.band200, w.fpl.band400], rows, w.fpl.title), income);
  }

  function renderQuadrant(brief) {
    const w = words();
    const { point } = brief.payload.gfe;
    const [W, H, left, right, top, bottom] = [640, 292, 66, 18, 20, 52];
    const plotW = W - left - right;
    const plotH = H - top - bottom;
    const [xMin, xMax, yMax] = [-100000, 120000, 180];
    const x = value => left + ((value - xMin) / (xMax - xMin)) * plotW;
    const y = value => top + plotH - (value / yMax) * plotH;
    const clampX = value => Math.min(xMax, Math.max(xMin, value));
    const clampY = value => Math.min(yMax, Math.max(0, value));
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': w.gfe.title });
    svg.append(svgEl('rect', { x: x(GFE.threshold), y: top, width: plotW - (x(GFE.threshold) - left), height: y(GFE.window) - top, class: 'quad-region' }));
    for (const value of [xMin, 0, GFE.threshold, xMax]) {
      const tick = svgEl('text', { x: x(value), y: top + plotH + 15, 'text-anchor': 'middle', class: 'chart-label chart-value' });
      tick.textContent = usd(value);
      svg.append(tick);
      svg.append(svgEl('line', { x1: x(value), x2: x(value), y1: top + plotH, y2: top + plotH + 4, class: 'chart-axis' }));
    }
    for (const value of [0, 60, GFE.window, yMax]) {
      const tick = svgEl('text', { x: left - 7, y: y(value) + 3, 'text-anchor': 'end', class: 'chart-label chart-value' });
      tick.textContent = `${value}`;
      svg.append(tick);
      svg.append(svgEl('line', { x1: left - 4, x2: left, y1: y(value), y2: y(value), class: 'chart-axis' }));
    }
    const axisY = svgEl('text', { x: left + plotW / 2, y: H - 8, 'text-anchor': 'middle', class: 'chart-label' });
    axisY.textContent = w.chart.gapAxis;
    svg.append(axisY);
    const axisX = svgEl('text', { x: 10, y: top + plotH / 2, 'text-anchor': 'middle', class: 'chart-label', transform: `rotate(-90 10 ${top + plotH / 2})` });
    axisX.textContent = w.chart.daysAxis;
    svg.append(axisX);
    svg.append(svgEl('line', { x1: left, x2: W - right, y1: y(0), y2: y(0), class: 'chart-axis' }));
    svg.append(svgEl('line', { x1: left, x2: left, y1: top, y2: top + plotH, class: 'chart-axis' }));
    svg.append(svgEl('line', { x1: x(GFE.threshold), x2: x(GFE.threshold), y1: top, y2: top + plotH, class: 'quad-line' }));
    svg.append(svgEl('line', { x1: left, x2: W - right, y1: y(GFE.window), y2: y(GFE.window), class: 'quad-line' }));
    const th = svgEl('text', { x: x(GFE.threshold) + 5, y: top + 11, class: 'chart-label' });
    th.textContent = w.chart.threshold;
    svg.append(th);
    const wl = svgEl('text', { x: left + 5, y: y(GFE.window) - 6, class: 'chart-label' });
    wl.textContent = w.chart.window;
    svg.append(wl);
    const zone = svgEl('text', { x: (x(GFE.threshold) + W - right) / 2, y: (top + y(GFE.window)) / 2, 'text-anchor': 'middle', class: 'chart-label quad-zone' });
    zone.textContent = w.chart.eligible;
    svg.append(zone);
    for (const [gi, gap] of BOUNDARY_GAPS.entries()) {
      for (const [di, days] of BOUNDARY_DAYS.entries()) {
        const stateName = brief.payload.gfe.boundary.matrix[gi][di];
        svg.append(svgEl('circle', { cx: x(gap), cy: y(days), r: 3, class: `quad-dot quad-${stateName === 'potential-ppdr' ? 'ok' : 'no'}` }));
      }
    }
    const marker = svgEl('g', { class: 'chart-bar', tabindex: '0', role: 'img', 'aria-label': w.aria.point(usd(point.gap), point.days, w.states[point.state] || point.state) });
    const title = svgEl('title');
    title.textContent = `${w.chart.current}: ${usd(point.gap)} / ${point.days} ${w.gfe.dayUnit}`;
    marker.append(title);
    marker.append(svgEl('circle', { cx: x(clampX(point.gap)), cy: y(clampY(point.days)), r: 6, class: 'quad-point' }));
    marker.append(svgEl('circle', { cx: x(clampX(point.gap)), cy: y(clampY(point.days)), r: 10, class: 'bar-ring' }));
    svg.append(marker);
    $('lab-quadrant').replaceChildren(svg);
  }

  function renderCases(brief) {
    const w = words();
    const heads = [w.cases.head, w.cases.flags, w.cases.checks, w.cases.estimate, w.cases.kinds, w.cases.documented, w.cases.plain];
    const rows = brief.payload.cases.map(row => tr => {
      cell(tr, heads[0], w.caseNames[row.id]);
      cell(tr, heads[1], String(row.review), 'money');
      cell(tr, heads[2], `${row.matched}/${row.checks}`, 'money');
      cell(tr, heads[3], w.states[row.estimate] || row.estimate);
      cell(tr, heads[4], row.kinds.join(', ') || 'none', 'kinds-cell');
      cell(tr, heads[5], String(row.probes.documented), 'money');
      cell(tr, heads[6], String(row.probes.plain), 'money');
    });
    $('lab-cases').replaceChildren(table(heads, rows, w.strings.casesTitle));
  }

  function renderBrief(brief) {
    const share = new URL('./', win.location.href);
    share.hash = encodeLabHash(state);
    $('lab-link').value = share.href;
    $('lab-digest').textContent = `SHA-256 ${brief.sha256}`;
  }

  function render() {
    const brief = briefFor(state);
    renderPfs(brief);
    renderChart(brief);
    renderBoundary(brief);
    renderQuadrant(brief);
    renderCases(brief);
    renderBrief(brief);
  }

  function update(patch) {
    const next = normalizeLabState({ ...state, ...patch });
    if (!next) {
      status('invalid');
      return false;
    }
    state = next;
    render();
    return true;
  }

  function readInputs() {
    const size = $('lab-size').valueAsNumber;
    const income = parseSignedDollars($('lab-income').value);
    const gap = parseSignedDollars($('lab-gap').value);
    const days = $('lab-days').valueAsNumber;
    if (!Number.isInteger(size) || income === null || gap === null || !Number.isInteger(days)) {
      status('invalid');
      return;
    }
    update({ size, income, gap, days });
  }

  function applyLanguage() {
    const w = words();
    for (const node of panel.querySelectorAll('[data-lab]')) {
      const text = w.strings[node.dataset.lab];
      if (text) node.textContent = text;
    }
    $('lab-title').textContent = w.title;
    panel.querySelector('.lab-head .segmented')?.setAttribute('aria-label', w.aria.labLanguage);
    for (const button of panel.querySelectorAll('[data-lab-language]')) {
      button.setAttribute('aria-pressed', String(button.dataset.labLanguage === language));
    }
    buildSelects();
    syncControls();
    render();
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = el('a');
    anchor.href = url;
    anchor.download = name;
    doc.body.append(anchor);
    anchor.click();
    anchor.remove();
    win.setTimeout(() => URL.revokeObjectURL(url), 20_000);
  }

  function runTests() {
    const results = selfTests().map(item => {
      try {
        item.run();
        return { ...item, pass: true };
      } catch (error) {
        return { ...item, pass: false, error: error.message };
      }
    });
    const w = words();
    const list = $('lab-test-list');
    list.replaceChildren(...results.map(result => {
      const li = el('li', '', result.pass ? 'test-pass' : 'test-fail');
      li.dataset.pass = String(result.pass);
      li.append(el('span', `${result.pass ? 'PASS' : 'FAIL'}`, 'test-mark'), el('span', w.tests[result.id] || result.id, 'test-name'),
        result.pass ? '' : el('span', result.error, 'test-error'));
      return li;
    }));
    const passing = results.filter(result => result.pass).length;
    $('lab-test-status').textContent = w.status.tests(passing, results.length);
    $('lab-test-status').dataset.all = String(passing === results.length);
    return results;
  }

  // Wiring
  $('lab-code').addEventListener('change', () => update({ code: $('lab-code').value }));
  for (const id of ['lab-size', 'lab-income', 'lab-gap', 'lab-days']) $(id).addEventListener('input', readInputs);
  for (const id of ['lab-controls', 'lab-boundary-form']) $(id)?.addEventListener('submit', event => event.preventDefault());
  for (const button of panel.querySelectorAll('[data-lab-language]')) {
    button.addEventListener('click', () => {
      if (button.dataset.labLanguage !== language) {
        language = button.dataset.labLanguage;
        applyLanguage();
      }
    });
  }
  $('lab-json').addEventListener('click', () => {
    download(`clearbill-sensitivity-${state.code}.json`, briefJson(briefFor(state)), 'application/json');
    status('json');
  });
  $('lab-csv').addEventListener('click', () => {
    download(`clearbill-sensitivity-${state.code}.csv`, briefCsv(briefFor(state)), 'text/csv;charset=utf-8');
    status('csv');
  });
  $('lab-md').addEventListener('click', () => {
    download(`clearbill-sensitivity-${state.code}.md`, briefMarkdown(briefFor(state), language), 'text/markdown;charset=utf-8');
    status('md');
  });
  $('lab-copy').addEventListener('click', async () => {
    const link = $('lab-link');
    try {
      await win.navigator.clipboard.writeText(link.value);
      status('copied');
    } catch {
      link.focus();
      link.select();
      status('copyManual');
    }
  });
  $('lab-verify').addEventListener('click', () => {
    const brief = briefFor(state);
    status(sha256Hex(canonical(brief.payload)) === brief.sha256 ? 'verified' : 'unexpected');
  });
  $('lab-tamper').addEventListener('click', () => {
    const brief = briefFor(state);
    const mutated = mutateBriefText(briefJson(brief));
    const result = verifyBriefDoc(mutated);
    $('lab-status').textContent = result.ok ? words().status.unexpected : words().status.tampered;
  });
  $('lab-run').addEventListener('click', runTests);

  buildSelects();
  applyLanguage();
  return {
    applyState(next) {
      const normalized = normalizeLabState(next);
      if (!normalized) return false;
      state = normalized;
      syncControls();
      render();
      return true;
    },
    runTests,
    getState: () => ({ ...state }),
    hash: () => encodeLabHash(state),
  };
}
