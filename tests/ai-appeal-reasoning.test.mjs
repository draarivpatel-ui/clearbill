import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES } from '../src/data.js';
import {
  analyzeBill, ASSIST_SCHEMA, benchmarkLines, buildAssistPayload, codingFindings, coverageTree,
  DEFAULT_SIM, disputeLetter, MARKUP_MEAN_X100, MARKUP_SD_X100, normalizeSim, recoverableRange,
  REASONING_SCHEMA, scrubPii, selfTests, simulateSettlement, SLIDER_LIMITS, validateEndpoint,
} from '../src/ai-appeal-reasoning.js';
import { audit } from '../src/engine.js';
import { canonical } from '../src/exchange.js';
import { createCase } from '../src/fixtures.js';
import { sha256Hex } from '../src/sensitivity-lab.js';

const analysisFor = id => analyzeBill(createCase(id));

test('analysis is deterministic and canonically serializable for every fixture', () => {
  for (const id of Object.keys(CASES)) {
    const a = analysisFor(id);
    const b = analysisFor(id);
    assert.equal(canonical(a), canonical(b));
    assert.equal(a.schema, REASONING_SCHEMA);
    assert.equal(a.ruleVersion, 'clearbill-2026q4-v2');
    assert.deepEqual(a.stages.map(stage => stage.id), ['benchmark', 'coding', 'coverage', 'plan']);
    assert(a.stages.every(stage => stage.steps.length > 0));
  }
});

test('benchmark scores every ER line with exact integer markup and z', () => {
  const rows = benchmarkLines(createCase('demo-er'), audit(createCase('demo-er')));
  assert.deepEqual(
    rows.map(row => [row.id, row.markupX100, row.zX100, row.band]),
    [
      ['line-1', 1201, 629, 'outlier'],
      ['line-2', 373, 38, 'typical'],
      ['line-3', null, null, 'no-reference'],
      ['line-4', null, null, 'no-reference'],
      ['line-5', 1179, 614, 'outlier'],
      ['line-6', 1179, 614, 'outlier'],
      ['line-7', 1139, 585, 'outlier'],
    ]);
  assert.equal(rows[0].comparisonOnly, true);
  assert.equal(rows[1].comparisonOnly, false);
});

for (const [billed, markup, band] of [
  [8923, 100, 'at-reference'], [9450, 106, 'typical'], [41046, 460, 'typical'],
  [53538, 600, 'elevated'], [41100, 461, 'elevated'], [53600, 601, 'outlier'],
]) {
  test(`benchmark band at ${billed} cents`, () => {
    const bill = createCase('demo-clean');
    bill.lines[0].billed = billed;
    const [row] = benchmarkLines(bill, audit(bill));
    assert.equal(row.markupX100, markup);
    assert.equal(row.band, band);
    assert.equal(row.zX100, Math.round((markup - MARKUP_MEAN_X100) * 100 / MARKUP_SD_X100));
  });
}

test('coding findings keep the engine order and cite rules with confidence', () => {
  const coding = analysisFor('demo-er').coding;
  assert.deepEqual(coding.map(item => item.kind), ['exact-duplicate', 'near-duplicate', 'ptp-pair-review', 'mue-units']);
  assert.deepEqual(coding.map(item => item.questionedCents), [12000, 800, 3900, 1018]);
  assert.deepEqual(coding.map(item => item.confidence), ['high', 'moderate', 'moderate', 'high']);
  assert.equal(coding[2].rule, 'NCCI PTP component pair');
  assert.equal(coding[2].source, 'ncciLab');
  assert.equal(coding[3].rule, 'CMS medically unlikely edit');
  assert.equal(coding[3].source, 'mue');
  assert.equal(analysisFor('demo-clean').coding.length, 0);
});

test('gfe threshold questions the full same-biller gap', () => {
  const coding = analysisFor('demo-imaging').coding;
  assert.equal(coding.length, 1);
  assert.equal(coding[0].kind, 'gfe-threshold');
  assert.equal(coding[0].questionedCents, 47500);
});

test('patient-total mismatch questions only the overcharged difference', () => {
  const bill = createCase('demo-clean');
  bill.totals.patient += 700;
  const coding = codingFindings(bill, audit(bill));
  const row = coding.find(item => item.kind === 'math-patient-total');
  assert.equal(row.questionedCents, 700);
  const under = createCase('demo-clean');
  under.totals.patient -= 700;
  const other = codingFindings(under, audit(under)).find(item => item.kind === 'math-patient-total');
  assert.equal(other.questionedCents, 0);
});

test('recoverable range removes cents already questioned by duplicate-line removal', () => {
  const er = analysisFor('demo-er').recoverable;
  assert.equal(er.grossQuestionedCents, 17718);
  assert.equal(er.overlapAdjustmentCents, 1418);
  assert.equal(er.highCents, 16300);
  assert(er.highCents < er.grossQuestionedCents, 'the same dollars must not be counted under duplicate and unit theories twice');
  assert.match(er.basis, /counts exact-duplicate overlaps once/);
  assert.match(er.basis, /\$177\.18; \$14\.18 is shared/);
});

test('recoverable range leaves non-overlapping findings additive', () => {
  const img = analysisFor('demo-imaging').recoverable;
  assert.equal(img.grossQuestionedCents, 47500);
  assert.equal(img.overlapAdjustmentCents, 0);
  assert.equal(img.highCents, 47500);
});

test('recoverable range does not double count duplicate dollars inside a good faith estimate gap', () => {
  const bill = createCase('demo-imaging');
  bill.lines.push({ ...bill.lines[0], id: 'line-2' });
  Object.assign(bill.totals, { billed: 225000, allowed: 225000, patient: 225000 });
  const report = audit(bill);
  const range = recoverableRange(bill, codingFindings(bill, report), report);
  assert.equal(range.grossQuestionedCents, 272500);
  assert.equal(range.overlapAdjustmentCents, 112500);
  assert.equal(range.lowCents, 160000);
  assert.equal(range.highCents, 160000);
});

test('coverage tree self-pay branches resolve every outcome', () => {
  assert.equal(analysisFor('demo-imaging').tree.outcome, 'potential-ppdr');
  assert.equal(analysisFor('demo-imaging').tree.branches.length, 4);
  const img = createCase('demo-imaging');
  const imgReport = audit(img);
  const forged = { ...imgReport, estimate: { ...imgReport.estimate, state: 'outside-window', elapsed: 121 } };
  assert.equal(coverageTree(img, forged).outcome, 'gfe-outside-window');
  const low = createCase('demo-imaging');
  low.lines[0].billed = 100000;
  assert.equal(coverageTree(low, audit(low)).outcome, 'gfe-below-threshold');
  const off = createCase('demo-imaging');
  off.gfe.election = false;
  assert.equal(coverageTree(off, audit(off)).outcome, 'gfe-prerequisites');
  const none = createCase('demo-imaging');
  none.gfe = null;
  assert.equal(coverageTree(none, audit(none)).outcome, 'gfe-unavailable');
});

test('coverage tree insured branches record unknowns honestly', () => {
  for (const [id, outcome] of [['demo-er', 'nsa-emergency-review'], ['demo-clean', 'nsa-ancillary-review']]) {
    const tree = analysisFor(id).tree;
    assert.equal(tree.coverage, 'insured');
    assert.equal(tree.outcome, outcome);
    assert.equal(tree.branches.filter(branch => branch.answer === 'unknown').length, 2);
    assert(tree.outcomeReason.length > 30);
  }
});

test('action plan orders strongest steps first and always closes with assistance', () => {
  const er = analysisFor('demo-er').plan;
  assert.deepEqual(er.map(item => item.id), ['duplicates', 'unbundling', 'units', 'network', 'verify', 'assistance']);
  assert.equal(er[0].effectCents, 12800);
  assert.equal(er[1].effectCents, 3900);
  assert.equal(er[2].effectCents, 1018);
  const img = analysisFor('demo-imaging').plan;
  assert.equal(img[0].id, 'ppdr');
  assert.equal(img[0].effectCents, 47500);
  assert(img.every((item, i) => item.priority === i + 1));
  const clean = analysisFor('demo-clean').plan;
  assert.deepEqual(clean.map(item => item.id), ['network', 'verify', 'assistance']);
});

test('recoverable range matches hand-computed questioned amounts and caps at patient share', () => {
  assert.deepEqual(
    [analysisFor('demo-er').recoverable, analysisFor('demo-imaging').recoverable, analysisFor('demo-clean').recoverable]
      .map(row => [row.lowCents, row.highCents]),
    [[12000, 16300], [47500, 47500], [0, 0]]);
  const huge = createCase('demo-imaging');
  huge.lines[0].billed = 20000000;
  const coding = codingFindings(huge, audit(huge));
  assert.equal(recoverableRange(huge, coding).highCents, huge.totals.patient);
});

test('dispute letter is deterministic, digested and cites questioned lines', () => {
  const analysis = analysisFor('demo-er');
  assert.equal(analysis.letter, disputeLetter(createCase('demo-er'), { plan: analysis.plan }));
  assert.equal(analysis.digest, sha256Hex(analysis.letter));
  assert.match(analysis.letter, /fictional dispute letter - practice copy/);
  assert.match(analysis.letter, /Questioned amount \$128\.00 \(L5, L6, L7\)/);
  assert.match(analysis.letter, /\[Your name\]/);
  assert.doesNotMatch(analysis.letter, /[‘’“”–—]/);
});

test('simulator leaves the share untouched at zero and never inverts at maximum', () => {
  const snapshot = createCase('demo-er');
  const analysis = analysisFor('demo-er');
  const zero = simulateSettlement(snapshot, analysis, { removalPct: 0, insurerPct: 0, discountPct: 0 });
  assert.deepEqual([zero.final, zero.delta, zero.removal], [zero.start, 0, 0]);
  const full = simulateSettlement(snapshot, analysis, { removalPct: 100, insurerPct: 50, discountPct: 90 });
  assert(full.final >= 0 && full.final < full.start);
  assert.equal(full.waterfall.length, 5);
  for (let i = 1; i < full.waterfall.length - 1; i++) assert.equal(full.waterfall[i].from, full.waterfall[i + 1].to);
});

test('simulator computes the exact published waterfall cents', () => {
  const er = simulateSettlement(createCase('demo-er'), analysisFor('demo-er'), DEFAULT_SIM);
  assert.deepEqual([er.removal, er.insurerAdj, er.discount, er.final, er.delta], [1993, 2801, 6302, 18904, 11096]);
  const img = simulateSettlement(createCase('demo-imaging'), analysisFor('demo-imaging'), { removalPct: 100, insurerPct: 0, discountPct: 0 });
  assert.equal(img.removal, 47500);
  assert.equal(img.final, img.start - 47500);
  const clean = simulateSettlement(createCase('demo-clean'), analysisFor('demo-clean'), DEFAULT_SIM);
  assert.equal(clean.removal, 0);
  assert.equal(clean.final, clean.start - clean.insurerAdj - clean.discount);
});

test('simulator defaults recover and hostile input is ignored', () => {
  assert.deepEqual(normalizeSim(null), DEFAULT_SIM);
  assert.deepEqual(normalizeSim('x'), DEFAULT_SIM);
  assert.deepEqual(normalizeSim({ insurerPct: 250, discountPct: -5, removalPct: 40 }), { removalPct: 40, insurerPct: 10, discountPct: 25 });
  for (const key of Object.keys(SLIDER_LIMITS)) assert(Number.isInteger(DEFAULT_SIM[key]));
});

for (const [input, hits] of [
  ['a.b+x@example.org', { email: 1 }],
  ['123-45-6789', { ssn: 1 }],
  ['(555) 010-2030', { phone: 1 }],
  ['555-010-2030 and 555.010.2031', { phone: 2 }],
  ['patient: Jane Doe', { label: 1 }],
  ['MRN: 445566', { label: 1 }],
  ['01/02/2011', { date: 1 }],
  ['acct 99112233', { id: 1 }],
  ['445566', {}],
]) {
  test(`scrub ${JSON.stringify(input.slice(0, 28))}`, () => {
    const scrub = scrubPii(input);
    for (const [kind, count] of Object.entries(hits)) assert.equal(scrub.hits[kind], count);
    if (!hits.date && !hits.id) assert(!/\d{7,}/.test(scrub.text));
    if (hits.email) assert(!scrub.text.includes('@'));
    if (hits.label) assert(scrub.text.includes('[redacted]'));
    if (!Object.keys(hits).length) assert.equal(scrub.text, input);
  });
}

test('assist payload is canonical-safe, carries fiction markers and scrubs context', () => {
  const payload = buildAssistPayload(analysisFor('demo-er'), {
    endpoint: ' https://api.example.com/v1/chat/completions ', model: 'demo-model', contextText: 'call (555) 010-2030',
  });
  assert.equal(payload.schema, ASSIST_SCHEMA);
  assert.equal(payload.transport.endpoint, 'https://api.example.com/v1/chat/completions');
  assert.equal(payload.request.model, 'demo-model');
  assert.equal(payload.request.messages.length, 2);
  assert.equal(payload.scrubReport.phone, 1);
  assert(!payload.request.messages[1].content.includes('010-2030') && !payload.request.messages[1].content.includes('(555)'));
  canonical(payload);
});

for (const [url, ok, reason] of [
  ['https://api.example.com/v1/chat/completions', true, 'https'],
  ['https://localhost:8443/x', true, 'https'],
  ['http://localhost:11434/v1/chat', true, 'loopback'],
  ['http://127.0.0.1:8080/chat', true, 'loopback'],
  ['http://[::1]:8080/chat', true, 'loopback'],
  ['http://api.example.com', false, 'https-required'],
  ['https://user:pass@api.example.com', false, 'no-credentials'],
  ['ftp://example.com', false, 'invalid'],
  ['data:text/plain,x', false, 'invalid'],
  ['not a url', false, 'invalid'],
  ['', false, 'empty'],
]) {
  test(`endpoint gate ${url || '(empty)'}`, () => {
    const verdict = validateEndpoint(url);
    assert.deepEqual([verdict.ok, verdict.reason], [ok, reason]);
  });
}

test('every in-page self-test passes', () => {
  const tests = selfTests();
  assert(tests.length >= 10);
  for (const item of tests) item.run();
});
