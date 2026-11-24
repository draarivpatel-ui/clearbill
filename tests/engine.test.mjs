import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES, CATALOG, LOCALITIES, PTP } from '../src/data.js';
import { assessPair, audit, calculateReference, compareEstimate, parseDollars, screenFpl, usd, validateSnapshot } from '../src/engine.js';
import { createCase } from '../src/fixtures.js';
import { worksheetTopics } from '../src/worksheet.js';

// Independent Decimal calculations from the original PPRRVU and GPCI CSV columns.
const reference = [
  ['45380', 'office', 'base', 48372, 55232, 44176],
  ['45380', 'facility', 'base', 18356, 20107, 16517],
  ['45385', 'office', 'base', 50527, 57364, 46135],
  ['45385', 'facility', 'base', 23065, 25227, 20830],
  ['70551', 'office', 'base', 19603, 22375, 18114],
  ['70551', 'office', '26', 6907, 7521, 6474],
  ['70551', 'facility', '26', 6907, 7521, 6474],
  ['70551', 'office', 'TC', 12695, 14854, 11640],
  ['71046', 'office', 'base', 3320, 3802, 3051],
  ['71046', 'office', '26', 1018, 1110, 959],
  ['71046', 'facility', '26', 1018, 1110, 959],
  ['71046', 'office', 'TC', 2301, 2692, 2091],
  ['72148', 'office', 'base', 19238, 21948, 17778],
  ['72148', 'office', '26', 6974, 7598, 6536],
  ['72148', 'facility', '26', 6974, 7598, 6536],
  ['72148', 'office', 'TC', 12264, 14350, 11243],
  ['74177', 'office', 'base', 30072, 34497, 27753],
  ['74177', 'office', '26', 8554, 9318, 7983],
  ['74177', 'facility', '26', 8554, 9318, 7983],
  ['74177', 'office', 'TC', 21518, 25178, 19769],
  ['99213', 'office', 'base', 9633, 10763, 8923],
  ['99213', 'facility', 'base', 5885, 6378, 5470],
  ['99281', 'facility', 'base', 1145, 1241, 1028],
  ['99282', 'facility', 'base', 4201, 4548, 3772],
  ['99283', 'facility', 'base', 7235, 7832, 6465],
  ['99284', 'facility', 'base', 12326, 13338, 10991],
  ['99285', 'facility', 'base', 17829, 19281, 15983],
  ['G0514', 'office', 'base', 6583, 7246, 6140],
  ['G0514', 'facility', 'base', 5190, 5616, 4856],
  ['G2211', 'office', 'base', 1767, 1939, 1648],
  ['G2211', 'facility', 'base', 1468, 1589, 1373],
];

for (const [code, setting, component, ...expected] of reference) {
  ['houston', 'manhattan', 'iowa'].forEach((locality, i) => {
    test(`RVU26D oracle ${code} ${setting}/${component} ${locality}`, () => {
      const result = calculateReference(code, locality, setting, component);
      assert.deepEqual([result.available, result.cents, result.conversion], [true, expected[i], 334009]);
    });
  });
}
for (const code of ['99281', '99282', '99283', '99284', '99285', '70551', '71046', '72148', '74177']) {
  test(`unavailable CMS facility/nonfacility setting ${code}`, () => {
    const setting = code.startsWith('99') ? 'office' : 'facility';
    assert.deepEqual(calculateReference(code, 'houston', setting), { available: false, reason: 'setting-not-applicable' });
    if (setting === 'facility') assert.equal(calculateReference(code, 'iowa', setting, 'TC').available, false);
  });
}
for (const code of ['36415', '80048', '80053', '80061', '82465', '82947', '83718', '84478', '85025']) {
  test(`separately scheduled service ${code} does not price at zero`, () => {
    assert.deepEqual(calculateReference(code, 'iowa', 'office'), { available: false, reason: 'not-listed' });
    assert.equal(calculateReference(code, 'houston', 'facility').available, false);
  });
}
test('Houston ER equation exposes the individual products and both amount types separately', () => {
  assert.deepEqual(calculateReference('99284', 'houston', 'facility').products, [276192, 44685, 48160]);
  const result = audit(createCase('demo-er'));
  assert.deepEqual(result.references.slice(0, 2), [
    { id: 'line-1', unitCents: 12326, lineCents: 12326, comparisonOnly: true },
    { id: 'line-2', unitCents: 12326, lineCents: 12326, comparisonOnly: false },
  ]);
});

for (const [id, locality, expected, topics] of [
  ['demo-er', 'houston', ['exact-duplicate', 'near-duplicate', 'ptp-pair-review', 'mue-units'], ['duplicate', 'ptp', 'mue', 'aid']],
  ['demo-imaging', 'manhattan', ['gfe-threshold'], ['gfe', 'aid']],
  ['demo-clean', 'iowa', [], ['clean', 'aid']],
]) {
  test(`synthetic reference result ${id}`, () => {
    const input = createCase(id);
    const result = audit(input);
    assert.equal(input.locality, locality);
    assert.deepEqual(result.findings.map(row => row.kind), expected);
    assert.equal(result.reviewCount, expected.length);
    assert.equal(result.balances.filter(row => row.matches).length, 4);
    assert.deepEqual(worksheetTopics(result), topics);
  });
}

const baseEstimate = { estimated: 65000, billed: 112500, election: true, estimateBeforeCare: true,
  initialBill: '2026-10-29', checkedOn: '2026-11-10', serviceDay: '2026-10-21' };
for (const gap of [-65000, -40001, -1, 0, 1, 39900, 39997, 39998, 39999, 40000, 40001, 40002, 40100, 47500, 150000]) {
  test(`self-pay threshold at ${gap} cents`, () => {
    const result = compareEstimate({ ...baseEstimate, billed: baseEstimate.estimated + gap });
    assert.deepEqual(result, {
      state: gap >= 40000 ? 'potential-ppdr' : 'below-threshold', gap, elapsed: 12, threshold: 40000, meetsAmount: gap >= 40000,
    });
  });
}
for (const [checkedOn, elapsed, state] of [
  ['2026-10-28', null, 'missing-prerequisites'], ['2026-10-29', 0, 'potential-ppdr'], ['2026-10-30', 1, 'potential-ppdr'],
  ['2027-02-25', 119, 'potential-ppdr'], ['2027-02-26', 120, 'potential-ppdr'], ['2027-02-27', 121, 'outside-window'],
  ['2027-03-01', 123, 'outside-window'], ['2027-02-29', null, 'missing-prerequisites'],
  ['2027-02-30', null, 'missing-prerequisites'], ['02/26/2027', null, 'missing-prerequisites'],
]) {
  test(`self-pay timing ${checkedOn}`, () => {
    const result = compareEstimate({ ...baseEstimate, checkedOn });
    assert.deepEqual([result.elapsed, result.state], [elapsed, state]);
  });
}
for (const patch of [{ election: false }, { estimateBeforeCare: false }, { serviceDay: '2021-12-31' }, { serviceDay: '2026-10-30' }]) {
  test(`self-pay does not infer prerequisite ${JSON.stringify(patch)}`, () => {
    assert.equal(compareEstimate({ ...baseEstimate, ...patch }).state, 'missing-prerequisites');
  });
}
test('provider-specific threshold excludes a second biller', () => {
  const bill = createCase('demo-imaging');
  bill.lines[0].billed = 104999;
  bill.lines.push({ ...bill.lines[0], id: 'line-2', billed: 300000, entity: 'demo-provider' });
  const { estimate, findings } = audit(bill);
  assert.equal(estimate.gap, 39999);
  assert(!findings.some(f => f.kind === 'gfe-threshold'));
});
test('provider-specific estimate is unavailable without matching evidence', () => {
  const bill = createCase('demo-imaging');
  bill.gfe.entity = 'demo-provider';
  assert.deepEqual(audit(bill).estimate, { state: 'unavailable' });
  bill.gfe.entity = 'demo-imaging';
  bill.lines.push({ ...bill.lines[0], id: 'line-2', day: '2026-10-08' });
  assert.deepEqual(audit(bill).estimate, { state: 'unavailable' });
});

const poverty = {
  contiguous: [15960, 21640, 27320, 33000, 55720, 61400, 95480],
  alaska: [19950, 27050, 34150, 41250, 69650, 76750, 119350],
  hawaii: [18360, 24890, 31420, 37950, 64070, 70600, 109780],
};
for (const [region, baselines] of Object.entries(poverty)) {
  [1, 2, 3, 4, 8, 9, 15].forEach((size, index) => {
    const guideline = baselines[index] * 100;
    test(`HHS guideline ${region} household ${size}`, () => {
      assert.deepEqual(screenFpl(region, size, guideline), { year: 2026, guideline, percentTenths: 1000, band: 'at-or-below-200' });
    });
    test(`hospital example bands compare exact income ${region} household ${size}`, () => {
      assert.equal(screenFpl(region, size, guideline * 2).band, 'at-or-below-200');
      const near = screenFpl(region, size, guideline * 2 + 1);
      assert.equal(near.percentTenths, 2000);
      assert.equal(near.band, 'at-or-below-400');
      assert.equal(screenFpl(region, size, guideline * 4).band, 'at-or-below-400');
      assert.equal(screenFpl(region, size, guideline * 4 + 1).band, 'above-400');
    });
  });
}
test('2026 FPL FAQ example has stable precision', () => {
  assert.deepEqual(screenFpl('contiguous', 3, 4000000), { year: 2026, guideline: 2732000, percentTenths: 1464, band: 'at-or-below-200' });
  assert.equal(screenFpl('alaska', 50, 0).percentTenths, 0);
});

const row = (modifiers = [], evidence = 'none') => ({ modifiers, evidence });
for (const [modifier, evidence] of Object.entries({ 59: 'site', XE: 'encounter', XS: 'site', XP: 'practitioner', XU: 'nonoverlap' })) {
  for (const [given, expected] of [[evidence, 'documented-review'], ['none', 'modifier-unverified'], ['repeat-lab', 'modifier-unverified']]) {
    test(`PTP ${modifier} with ${given} on either code, without implying payment`, () => {
      const coded = row([modifier], given);
      assert.equal(assessPair(row(), coded, 1, 'surgery'), expected);
      assert.equal(assessPair(coded, row(), 1, 'surgery'), expected);
      assert.equal(assessPair(row(), coded, 0, 'surgery'), 'no-exception');
      assert.equal(assessPair(row(), coded, 9, 'surgery'), 'inactive');
    });
  }
}
for (const [modifier, matches] of [['59', true], ['91', true], ['XE', false], ['XS', false], ['XP', false], ['XU', false], ['76', false], ['77', false]]) {
  test(`lab repeat evidence with modifier ${modifier}`, () => {
    const actual = assessPair(row(), row([modifier], 'repeat-lab'), 1, 'laboratory');
    assert.equal(actual, matches ? 'documented-review' : ['76', '77'].includes(modifier) ? 'pair-review' : 'modifier-unverified');
    assert.notEqual(assessPair(row([modifier], 'repeat-lab'), row(), 1, 'laboratory'), 'documented-review');
  });
}
function addedLine(id, code, overrides = {}) {
  return { ...createCase('demo-clean').lines[0], id: `line-${id}`, billed: 0, code, ...overrides };
}
const byKind = (bill, kind) => audit(bill).findings.filter(f => f.kind === kind);
for (const [first, second, indicator] of PTP) {
  for (const boundary of ['same', 'date', 'biller', 'institutional']) {
    test(`published PTP ${first}/${second} indicator ${indicator} ${boundary} boundary`, () => {
      const bill = createCase('demo-clean');
      const a = addedLine(4, first, boundary === 'institutional' ? { entity: 'demo-hospital' } : {});
      const b = addedLine(5, second, boundary === 'date' ? { day: '2026-10-08' }
        : boundary === 'biller' ? { entity: 'demo-lab' } : boundary === 'institutional' ? { entity: 'demo-hospital' } : {});
      bill.lines.push(b, a);
      const flags = byKind(bill, 'ptp-pair-review');
      assert.equal(flags.length, boundary === 'same' ? 1 : 0);
      if (flags.length) assert.deepEqual(flags[0].lineIds, ['line-4', 'line-5']);
    });
  }
}
for (const [code, cap, mai] of [
  ['36415', 2, 3], ['45380', 1, 2], ['45385', 1, 2], ['70551', 2, 3], ['71046', 2, 3],
  ['72148', 1, 3], ['74177', 2, 3], ['80048', 2, 3], ['80053', 1, 3], ['80061', 1, 3],
  ['82465', 1, 3], ['82947', 5, 3], ['83718', 1, 3], ['84478', 1, 3], ['85025', 2, 3],
  ['99281', 1, 3], ['99282', 1, 3], ['99283', 1, 3], ['99284', 1, 3], ['99285', 1, 3], ['G0514', 1, 1],
]) {
  for (const add of [0, 1]) {
    test(`published MUE ${code} ${add ? 'above' : 'at'} cap ${cap}`, () => {
      const bill = createCase('demo-clean');
      bill.lines[0] = addedLine(1, code, { units: cap + add, billed: bill.lines[0].billed, entity: 'demo-provider' });
      bill.lines = bill.lines.slice(0, 1);
      const findings = byKind(bill, 'mue-units');
      assert.equal(findings.length, add);
      if (add) assert.match(findings[0].detail, new RegExp(`MAI ${mai}\\)`));
    });
  }
}
for (const [code, expected] of [['G0514', 0], ['45385', 1], ['99284', 1]]) {
  test(`MUE split lines respect per-line vs daily adjudication ${code}`, () => {
    const bill = createCase('demo-clean');
    bill.lines.push(addedLine(4, code, { modifiers: ['59'], evidence: 'site' }), addedLine(5, code));
    const hits = byKind(bill, 'mue-units');
    assert.equal(hits.length, expected);
    if (expected) assert.deepEqual(hits[0].lineIds, ['line-4', 'line-5']);
  });
}
test('documented repeat laboratory charges are not misread as exact duplicates', () => {
  const bill = createCase('demo-clean');
  const repeated = {
    ...addedLine(4, '85025', { billed: 4200, modifiers: ['91'], evidence: 'repeat-lab', entity: 'demo-lab' }),
  };
  bill.lines.push(repeated, { ...repeated, id: 'line-5' });
  assert.equal(byKind(bill, 'exact-duplicate').length, 0);
});

test('undocumented repeat-looking laboratory charges still flag as exact duplicates', () => {
  const bill = createCase('demo-clean');
  const repeated = {
    ...addedLine(4, '85025', { billed: 4200, modifiers: ['91'], evidence: 'none', entity: 'demo-lab' }),
  };
  bill.lines.push(repeated, { ...repeated, id: 'line-5' });
  assert.equal(byKind(bill, 'exact-duplicate').length, 1);
});


test('repeat-lab evidence does not hide duplicate non-laboratory charges', () => {
  const bill = createCase('demo-clean');
  const repeated = {
    ...addedLine(4, '71046', { billed: 12000, modifiers: ['26', '91'], evidence: 'repeat-lab', entity: 'demo-provider' }),
  };
  bill.lines.push(repeated, { ...repeated, id: 'line-5' });
  assert.equal(byKind(bill, 'exact-duplicate').length, 1);
});

test('daily MUE does not cross providers, dates, or into an institutional bill', () => {
  const bill = createCase('demo-clean');
  bill.lines.push(addedLine(4, '99284'), addedLine(5, '99284', { day: '2026-10-08' }),
    addedLine(6, '99284', { entity: 'demo-lab' }), addedLine(7, '99284', { entity: 'demo-hospital', units: 3 }));
  assert.equal(byKind(bill, 'mue-units').length, 0);
});

for (const [base, delta, exact, near] of [
  [0, 0, 1, 0], [0, 1, 0, 0], [1999, 100, 0, 0], [2000, 0, 1, 0], [2000, 99, 0, 1],
  [2000, 100, 0, 1], [2000, 101, 0, 0], [49999, 2500, 0, 0], [50000, 2500, 0, 1],
  [100000, 2501, 0, 0], [100000, 2500, 0, 1], [100000, 2499, 0, 1],
]) {
  test(`near duplicate boundaries at ${base} + ${delta}`, () => {
    const bill = createCase('demo-clean');
    bill.lines.push(addedLine(4, '71046', { billed: base }), addedLine(5, '71046', { billed: base + delta }));
    assert.equal(byKind(bill, 'exact-duplicate').length, exact);
    assert.equal(byKind(bill, 'near-duplicate').length, near);
  });
}
for (const [patch, count] of [
  [{ day: '2026-10-08' }, 0], [{ entity: 'demo-lab' }, 0], [{ units: 2 }, 0], [{ modifiers: ['TC'] }, 0],
  [{ modifiers: ['26', '59'] }, 1], [{ modifiers: ['59', '26'] }, 1],
  [{ modifiers: ['26', '59'], evidence: 'site' }, 0], [{ modifiers: ['26', '59'], evidence: 'practitioner' }, 1],
]) {
  test(`duplicate grouping distinguishes ${JSON.stringify(patch)}`, () => {
    const bill = createCase('demo-clean');
    bill.lines.push(addedLine(4, '71046', { modifiers: ['59', '26'], billed: 3200 }),
      addedLine(5, '71046', { modifiers: ['26', '59'], billed: 3200, ...patch }));
    assert.equal(byKind(bill, 'exact-duplicate').length, count);
  });
}

for (const id of Object.keys(CASES)) {
  const selfPay = id === 'demo-imaging';
  for (const [field, expected] of [
    ['billed', ['line-total', 'allowed-total']], ['adjustment', ['allowed-total']], ['allowed', ['allowed-total', 'payer-total']],
    ['deductible', ['patient-total']], ['coinsurance', ['patient-total']], ['copay', ['patient-total']],
    ['insurer', selfPay ? ['patient-total', 'payer-total'] : ['payer-total']],
    ['patient', selfPay ? ['payer-total'] : ['patient-total', 'payer-total']],
  ]) {
    for (const change of [1, 2501]) {
      test(`${id} catches ${change} cent mismatch in ${field}`, () => {
        const bill = createCase(id);
        bill.totals[field] += change;
        const math = audit(bill).balances.filter(item => !item.matches);
        assert.deepEqual(math.map(item => item.key), expected);
        assert(math.every(item => Math.abs(item.computed - item.reported) === change));
      });
    }
  }
}

for (const [input, expected] of [
  ['0', 0], ['0.01', 1], ['0.1', 10], ['1.01', 101], ['1000000.00', 100000000], ['01.05', 105],
  ['', null], ['.01', null], ['1.', null], [' 1', null], ['1e2', null], ['0.001', null], ['1000000.01', null],
  ['+5', null], ['-0.01', null], ['1,000', null], ['9007199254740991', null], ['\uff11\uff10', null], [null, null], [1, null],
]) test(`parse exact dollars ${JSON.stringify(input)}`, () => assert.equal(parseDollars(input), expected));

function generator(seed) {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
}
const random = generator(0xc1ea4b11);
for (let i = 0; i < 36; i++) {
  const charge = random() % 984399;
  const extra = random() % 9900 + 1;
  test(`seeded cents reconciliation ${i}`, () => {
    const bill = createCase('demo-clean');
    bill.lines[0].billed = charge;
    const reported = charge + 4500 + extra;
    Object.assign(bill.totals, { billed: reported, adjustment: 0, allowed: reported, insurer: reported - 2500 });
    const result = audit(bill);
    assert.deepEqual(result.balances.map(item => item.matches), [false, true, true, true]);
    assert.equal(result.balances[0].computed, reported - extra);
    assert.equal(parseDollars(usd(charge).replace(/[$,]/g, '')), charge);
  });
}
const invalid = [Infinity, NaN, 0, -1, 501, 1.2, '3', null, [], {}, true, undefined];
for (const field of ['units', 'code', 'entity', 'day', 'evidence', 'setting']) {
  for (const [index, value] of invalid.entries()) {
    test(`reject malformed ${field} ${index}`, () => {
      const bill = createCase('demo-clean');
      bill.lines[0][field] = value;
      assert.throws(() => validateSnapshot(bill), TypeError);
    });
  }
}
test('unknown IDs, arbitrary case fields, and duplicate line IDs reject', () => {
  const bill = createCase('demo-clean');
  assert.throws(() => createCase('__proto__'));
  assert.throws(() => calculateReference('toString', 'houston', 'office'));
  assert.throws(() => screenFpl('constructor', 1, 1));
  assert.throws(() => audit({ ...bill, account: 'not admitted' }));
  bill.lines[1].id = bill.lines[0].id;
  assert.throws(() => audit(bill));
});
test('all shipped presets remain cleanly structured for every visible locality', () => {
  for (const key of Object.keys(CASES)) for (const locality of Object.keys(LOCALITIES)) {
    const input = createCase(key, locality);
    assert(input.lines.every(line => Object.hasOwn(CATALOG, line.code)));
    assert.equal(validateSnapshot(input), input);
  }
});
