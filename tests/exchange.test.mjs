import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CASES, LOCALITIES } from '../src/data.js';
import { canonical, csvCell, makeBundle, makeCsv, MAX_BUNDLE_BYTES, openSummary, sealSummary, sha256, verifyBundle } from '../src/exchange.js';
import { createCase } from '../src/fixtures.js';

test('canonical key order, array order and integer JSON are stable', () => {
  const expected = '{"case":"fictional","nested":{"a":null,"b":[2,1]},"v":true}';
  assert.equal(canonical({ nested: { b: [2, 1], a: null }, v: true, case: 'fictional' }), expected);
  assert.equal(canonical(JSON.parse(expected)), expected);
  assert.notEqual(canonical(JSON.parse(expected.replace('[2,1]', '[1,2]'))), expected);
});
for (const value of [Infinity, -Infinity, NaN, undefined, 1.2, new Date(0), 1n, { a: undefined }, [, 1], () => 'data']) {
  test(`canonical rejects unsupported ${typeof value} ${String(value)}`, () => assert.throws(() => canonical(value), TypeError));
}
for (const [value, expected] of [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
]) test(`SHA-256 known vector ${JSON.stringify(value)}`, async () => assert.equal(await sha256(value), expected));

for (const [id, expected] of [['demo-er', 4], ['demo-imaging', 1], ['demo-clean', 0]]) {
  test(`JSON digest, immutable snapshot and replay for ${id}`, async () => {
    const source = createCase(id);
    const doc = await makeBundle(source);
    const expectedDigest = createHash('sha256').update(canonical(doc.payload)).digest('hex');
    assert.equal(doc.sha256, expectedDigest);
    assert.equal((await makeBundle(createCase(id))).sha256, expectedDigest);
    const result = await verifyBundle(JSON.stringify({ sha256: doc.sha256, payload: doc.payload }, null, 2));
    assert.deepEqual(result, { ok: true, sha256: expectedDigest, reviewCount: expected, caseId: id });
    source.lines[0].billed += 1;
    assert.notEqual(doc.payload.input.lines[0].billed, source.lines[0].billed);
  });
}
const alterations = [
  ['hash changed', doc => { doc.sha256 = '0'.repeat(64); }, false, /digest mismatch/],
  ['input changed', doc => { doc.payload.input.lines[0].billed++; }, false, /deterministic replay/],
  ['forged output and recomputed hash', doc => { doc.payload.report.reviewCount = 0; }, true, /deterministic replay/],
  ['report omits a finding', doc => { doc.payload.report.findings.pop(); }, true, /deterministic replay/],
  ['wrong version', doc => { doc.payload.report.ruleVersion = 'unknown-v2'; }, true, /rule version/],
  ['outside schema', doc => { doc.account = 'blocked'; }, false, /bundle format/],
  ['private field', doc => { doc.payload.input.lines[0].account = 'blocked'; }, true, /Invalid bundle/],
  ['prototype-looking code', doc => { doc.payload.input.lines[0].code = '__proto__'; }, true, /Invalid bundle/],
];
for (const [caption, mutate, rehash, reason] of alterations) {
  test(`replay rejects ${caption}`, async () => {
    const doc = await makeBundle(createCase('demo-er'));
    mutate(doc);
    if (rehash) doc.sha256 = await sha256(canonical(doc.payload));
    const result = await verifyBundle(JSON.stringify(doc));
    assert.equal(result.ok, false);
    assert.match(result.reason, reason);
  });
}
for (const input of ['no', null, '[]', 'null', '{}', 'x'.repeat(MAX_BUNDLE_BYTES + 1), '\u00e9'.repeat(MAX_BUNDLE_BYTES)]) {
  test(`bundle rejects malformed or oversize input ${typeof input} ${input?.length}`, async () => assert.equal((await verifyBundle(input)).ok, false));
}
test('a modified but internally consistent fictional bundle is valid, not authenticated', async () => {
  const snapshot = createCase('demo-er');
  const original = await makeBundle(snapshot);
  snapshot.lines[0].billed -= 1;
  const changed = await makeBundle(snapshot);
  assert.notEqual(changed.sha256, original.sha256);
  assert.equal((await verifyBundle(canonical(changed))).reviewCount, 5);
});

for (const [cell, expected] of [
  ['=1+1', `"'=1+1"`], ['+1', `"'+1"`], ['-5', `"'-5"`], ['@SUM(1)', `"'@SUM(1)"`],
  ['  =1', `"'  =1"`], ['\t -4', `"'\t -4"`], ['\rHi', `"'\rHi"`], ['\n Hi', `"'\n Hi"`],
  ['\u00a0=8', `"'\u00a0=8"`], ['\ufeff@SUM(1)', `"'\ufeff@SUM(1)"`], ['\uff1d1', `"'\uff1d1"`], ['\u0001-1', `"'\u0001-1"`],
  ['"hi",quoted', '"""hi"",quoted"'], ['hello\nworld', '"hello\nworld"'], [null, '""'], [-8, '-8'], [12500, '12500'],
]) test(`spreadsheet-safe field ${JSON.stringify(cell)}`, () => assert.equal(csvCell(cell), expected));
for (const [id, count] of [['demo-er', 16], ['demo-imaging', 8], ['demo-clean', 8]]) {
  test(`CSV ${id} preserves every record and exact integer cents`, () => {
    const csv = makeCsv(createCase(id));
    const rows = csv.trimEnd().split('\r\n');
    assert.equal(rows.length, count);
    assert(csv.endsWith('\r\n'));
    assert.equal(rows[0].split(',').length, 20);
    const parseRow = row => [...row.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|(-?\d+))(?=,|$)/g)];
    assert(rows.every(row => parseRow(row).length === 20));
    assert(rows.some(row => row.startsWith('"balance"') && row.includes('"matches"')));
    if (id === 'demo-imaging') assert.match(csv, /,47500,40000,"potential-ppdr"/);
    if (id === 'demo-er') assert.match(csv, /,148000,12326,12326,"Professional illustration only; not a facility fee"/);
  });
}

function tamper(value, index) {
  return value.slice(0, index) + (value[index] === 'A' ? 'B' : 'A') + value.slice(index + 1);
}
for (const id of Object.keys(CASES)) {
  for (const locality of Object.keys(LOCALITIES)) {
    test(`AES-GCM authenticates fictional summary ${id}/${locality}`, async () => {
      const a = await sealSummary(id, locality);
      const b = await sealSummary(id, locality);
      assert.match(a.fragment, /^#sealed=v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
      assert.match(a.key, /^[A-Za-z0-9_-]{43}$/);
      assert(!a.fragment.includes(a.key));
      assert.notEqual(a.fragment, b.fragment);
      assert.notEqual(a.key, b.key);
      assert.deepEqual(await openSummary(a.fragment, a.key), { id, locality });
      await assert.rejects(openSummary(a.fragment, b.key), /Could not open/);
    });
  }
}
for (const [label, mutate] of [
  ['IV bit', f => tamper(f, 12)], ['cipher bit', f => tamper(f, 33)], ['late cipher bit', f => tamper(f, f.length - 5)],
  ['truncation', f => f.slice(0, -8)], ['extension', f => `${f}a`], ['version', f => f.replace('v1.', 'v2.')],
  ['unexpected segment', f => `${f}.AAAA`], ['padding', f => `${f}=`], ['oversize', f => f + 'A'.repeat(521)], ['empty', () => ''],
]) {
  test(`AES-GCM rejects ${label}`, async () => {
    const { fragment, key } = await sealSummary('demo-er', 'iowa');
    await assert.rejects(openSummary(mutate(fragment), key), /Could not open/);
  });
}
test('AES-GCM rejects noncanonical base64url at a key tail', async () => {
  const { fragment, key } = await sealSummary('demo-er', 'iowa');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical = key.slice(0, -1) + chars[chars.indexOf(key.at(-1)) + 1];
  assert.deepEqual(Buffer.from(noncanonical, 'base64url'), Buffer.from(key, 'base64url'));
  await assert.rejects(openSummary(fragment, noncanonical), /Could not open/);
});
for (const [id, locality] of [['toString', 'iowa'], ['demo-er', '__proto__'], ['demo-er', '*'], ['bill-123', 'houston'], [{ id: 'demo-er' }, 'houston']]) {
  test(`summary whitelist rejects ${JSON.stringify([id, locality])}`, () => assert.rejects(sealSummary(id, locality), /Only fictional/));
}
