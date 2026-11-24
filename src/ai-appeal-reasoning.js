// AI reasoning lab: a deterministic, offline-first rule and statistical reasoning
// engine for fictional bills. Every trace step is reproducible integer math.
// No network calls, no remote model: the optional assist adapter only builds a
// PII-scrubbed request payload the user may carry to their own endpoint.
import { CASES, CATALOG, LOCALITIES, RULESET } from './data.js';
import { audit, usd } from './engine.js';
import { canonical } from './exchange.js';
import { createCase } from './fixtures.js';
import { sha256Hex } from './sensitivity-lab.js';

export const REASONING_SCHEMA = 'clearbill-reasoning-v1';
export const ASSIST_SCHEMA = 'clearbill-assist-v1';

// Illustrative fictional chargemaster distribution in hundredths of the
// clinician reference: mean markup 3.20x, standard deviation 1.40x.
// These are teaching constants, not measured provider data.
export const MARKUP_MEAN_X100 = 320;
export const MARKUP_SD_X100 = 140;
export const SLIDER_LIMITS = Object.freeze({
  removalPct: Object.freeze([0, 100]),
  insurerPct: Object.freeze([0, 50]),
  discountPct: Object.freeze([0, 90]),
});
export const DEFAULT_SIM = Object.freeze({ removalPct: 100, insurerPct: 10, discountPct: 25 });

function check(condition, detail) {
  if (!condition) throw new Error(`Self-test failed: ${detail}`);
}

const roundHalfUp = value => Math.floor(value + 0.5);
const intIn = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : undefined);

// Stage 1: per-line benchmark scoring against the Medicare clinician reference.
export function benchmarkLines(snapshot, report) {
  return snapshot.lines.map((line, i) => {
    const ref = report.references[i];
    if (ref.lineCents === null) {
      return { id: line.id, code: line.code, billed: line.billed, referenceCents: null, markupX100: null, zX100: null, band: 'no-reference' };
    }
    const markupX100 = roundHalfUp((line.billed * 100) / ref.unitCents);
    const zX100 = roundHalfUp(((markupX100 - MARKUP_MEAN_X100) * 100) / MARKUP_SD_X100);
    const band = markupX100 <= 105 ? 'at-reference'
      : zX100 <= 100 ? 'typical' : zX100 <= 200 ? 'elevated' : 'outlier';
    return { id: line.id, code: line.code, billed: line.billed, referenceCents: ref.lineCents,
      markupX100, zX100, band, comparisonOnly: ref.comparisonOnly === true };
  });
}

const CONFIDENCE = Object.freeze({
  'exact-duplicate': 95, 'near-duplicate': 65, 'ptp-no-exception': 90, 'ptp-modifier-unverified': 75,
  'ptp-pair-review': 60, 'ptp-documented-review': 35, 'mue-units': 85, 'gfe-threshold': 80,
  'gfe-context': 40, 'math-patient-total': 88, 'math-line-total': 88, 'math-allowed-total': 88, 'math-payer-total': 88,
});
const RULE_TEXT = Object.freeze({
  'exact-duplicate': 'Repeat-charge screen', 'near-duplicate': 'Repeat-charge screen',
  'ptp-no-exception': 'NCCI PTP indicator 0', 'ptp-modifier-unverified': 'NCCI PTP modifier evidence',
  'ptp-pair-review': 'NCCI PTP component pair', 'ptp-documented-review': 'NCCI PTP documented exception',
  'mue-units': 'CMS medically unlikely edit', 'gfe-threshold': 'CMS self-pay $400 and 120-day screens',
  'gfe-context': 'CMS self-pay dispute context', 'math-patient-total': 'Ledger reconciliation',
  'math-line-total': 'Ledger reconciliation', 'math-allowed-total': 'Ledger reconciliation', 'math-payer-total': 'Ledger reconciliation',
});
const RATIONALE = Object.freeze({
  'exact-duplicate': 'Identical code, units, modifiers, price, biller and date. Two indistinguishable charges rarely represent two distinct services.',
  'near-duplicate': 'Same signature with a price difference inside the tolerance. Worth a question, not an accusation.',
  'ptp-no-exception': 'The published indicator never permits a modifier bypass for this pair.',
  'ptp-modifier-unverified': 'A distinct-service modifier is present, but the fictional evidence on file does not match it.',
  'ptp-pair-review': 'No distinct-service modifier shown for a documented component pair.',
  'ptp-documented-review': 'A matching modifier and evidence are shown, so the pair may be defensible. Confirm, do not assume.',
  'mue-units': 'Same-biller same-day units exceed the selected published cap.',
  'gfe-threshold': 'The inclusive $400 amount screen and 120-day window both pass on the fictional dates.',
  'gfe-context': 'A screen failed; the amount still warrants a call.',
  'math-patient-total': 'Reported patient share does not equal the computed cost-sharing sum.',
  'math-line-total': 'Reported billed total does not equal the sum of line charges.',
  'math-allowed-total': 'Reported allowed amount does not equal billed minus adjustment.',
  'math-payer-total': 'Plan payment plus patient share does not equal the allowed amount.',
});

function confidenceLabel(x100) {
  return x100 >= 85 ? 'high' : x100 >= 60 ? 'moderate' : 'exploratory';
}

function questionedFor(finding, lineById, report, snapshot) {
  const lines = finding.lineIds.map(id => lineById.get(id)).filter(Boolean);
  switch (finding.kind) {
    case 'exact-duplicate':
      return lines.length > 1 ? lines.slice(1).reduce((sum, line) => sum + line.billed, 0) : 0;
    case 'near-duplicate': {
      const min = Math.min(...lines.map(line => line.billed));
      return lines.reduce((sum, line) => sum + (line.billed - min), 0);
    }
    case 'ptp-no-exception':
    case 'ptp-modifier-unverified':
    case 'ptp-pair-review': {
      // The column-two line is listed last in the finding.
      const target = lines[lines.length - 1];
      return target ? target.billed : 0;
    }
    case 'ptp-documented-review':
      return 0;
    case 'mue-units': {
      const totalUnits = lines.reduce((sum, line) => sum + line.units, 0);
      const limit = CATALOG[lines[0]?.code]?.mue?.[0];
      if (!limit || totalUnits <= limit) return 0;
      const refUnit = report.references.find(row => row.id === lines[0].id)?.unitCents;
      const unitPrice = refUnit ?? roundHalfUp(lines.reduce((sum, line) => sum + line.billed, 0) / totalUnits);
      return (totalUnits - limit) * unitPrice;
    }
    case 'gfe-threshold':
      return report.estimate?.state === 'potential-ppdr' ? report.estimate.gap : 0;
    case 'math-patient-total': {
      const row = report.balances.find(balance => balance.key === 'patient-total');
      return row && row.reported > row.computed ? row.reported - row.computed : 0;
    }
    default:
      return 0;
  }
}

// Stage 2: coding-pattern inference with cited rules and illustrative confidence.
export function codingFindings(snapshot, report) {
  const lineById = new Map(snapshot.lines.map(line => [line.id, line]));
  return report.findings.map(finding => ({
    kind: finding.kind,
    level: finding.level,
    title: finding.title,
    detail: finding.detail,
    lineIds: [...finding.lineIds],
    rule: RULE_TEXT[finding.kind] || 'Ledger reconciliation',
    source: finding.source,
    confidenceX100: CONFIDENCE[finding.kind] ?? 50,
    confidence: confidenceLabel(CONFIDENCE[finding.kind] ?? 50),
    rationale: RATIONALE[finding.kind] || 'A balance check did not reconcile.',
    questionedCents: questionedFor(finding, lineById, report, snapshot),
  }));
}

// Stage 3: explicit coverage-protection decision tree (NSA and GFE branches).
export function coverageTree(snapshot, report) {
  const selfPay = CASES[snapshot.id].coverage === 'Self-pay bill';
  const branches = [];
  const push = (id, question, answer, detail) => branches.push({ id, question, answer, detail });
  if (selfPay) {
    const { gfe } = snapshot;
    const estimate = report.estimate;
    push('gfe-present', 'Written good faith estimate on file?', gfe ? 'yes' : 'no',
      gfe ? 'The fixture carries a written estimate for the same biller.' : 'No estimate is attached to this fictional bill.');
    if (!gfe || !estimate || estimate.state === 'unavailable') {
      return { coverage: 'self-pay', branches, outcome: 'gfe-unavailable',
        outcomeReason: 'Without a written same-biller estimate the federal self-pay dispute screens cannot run. Ask the biller for its correction policy.' };
    }
    push('gfe-prereq', 'Estimate issued before care, with the dispute election?', estimate.state === 'missing-prerequisites' ? 'no' : 'yes',
      estimate.state === 'missing-prerequisites' ? 'A prerequisite field is false or a date is invalid.' : 'Both fictional prerequisites are recorded.');
    if (estimate.state === 'missing-prerequisites') {
      return { coverage: 'self-pay', branches, outcome: 'gfe-prerequisites',
        outcomeReason: 'A prerequisite did not hold in this fictional record. Correction with the biller is still possible.' };
    }
    push('gfe-amount', 'Same-biller gap at least $400?', estimate.meetsAmount ? 'yes' : 'no',
      `The same-biller difference is ${usd(estimate.gap)} against the ${usd(estimate.threshold)} screen.`);
    if (!estimate.meetsAmount) {
      return { coverage: 'self-pay', branches, outcome: 'gfe-below-threshold',
        outcomeReason: 'The gap is below the federal dispute screen. Ask about correction and assistance anyway.' };
    }
    push('gfe-window', 'Within 120 days of the initial bill?', estimate.elapsed !== null && estimate.elapsed <= 120 ? 'yes' : 'no',
      estimate.elapsed === null ? 'The elapsed-day count could not be computed.' : `The initial bill was ${estimate.elapsed} days old at the fictional check date.`);
    if (estimate.elapsed === null || estimate.elapsed > 120) {
      return { coverage: 'self-pay', branches, outcome: 'gfe-outside-window',
        outcomeReason: 'The fictional timing is outside the 120-day federal filing window. Correction and assistance questions remain open.' };
    }
    return { coverage: 'self-pay', branches, outcome: 'potential-ppdr',
      outcomeReason: 'Every fictional screen passes: written estimate, election, at least $400 over, and inside 120 days. This suggests eligibility review, not a ruling.' };
  }
  const emergency = CASES[snapshot.id].setting === 'Emergency care';
  push('emergency', 'Emergency care setting?', emergency ? 'yes' : 'no',
    emergency ? 'The fictional episode is emergency care.' : 'The fictional episode is scheduled or office care.');
  push('network-status', 'Out-of-network status on file?', 'unknown',
    'The fictional fixture does not record the network status of any biller.');
  push('ancillary', 'Ancillary provider at an in-network facility?', 'unknown',
    'Federal protections can limit balance billing for ancillary services at in-network facilities, but the fixture has no facility-network field.');
  return { coverage: 'insured', branches,
    outcome: emergency ? 'nsa-emergency-review' : 'nsa-ancillary-review',
    outcomeReason: emergency
      ? 'Federal emergency protections may limit out-of-network balance billing. Confirm network status with the plan before assuming a balance is owed.'
      : 'For scheduled insured care, ask the plan whether every biller was in-network and whether any ancillary protection applies.' };
}

// Stage 4: prioritized appeal plan plus the recoverable range.
export function actionPlan(snapshot, report, tree, coding) {
  const plan = [];
  const questioned = kind => coding.filter(item => item.kind === kind).reduce((sum, item) => sum + item.questionedCents, 0);
  const lineIds = kind => [...new Set(coding.filter(item => item.kind === kind).flatMap(item => item.lineIds))];
  if (tree.outcome === 'potential-ppdr') {
    plan.push({ id: 'ppdr', action: 'Start a patient-provider dispute request for the same-biller overage',
      rationale: 'All fictional screens pass. The federal process lets an eligible self-pay patient dispute a bill at least $400 above its written estimate.',
      lineIds: lineIds('gfe-threshold'), effectCents: report.estimate.gap });
  }
  const dupCents = questioned('exact-duplicate') + questioned('near-duplicate');
  if (dupCents) {
    plan.push({ id: 'duplicates', action: 'Ask the billing office to identify the service behind each repeated charge',
      rationale: 'Repeated charges on the same date and biller need a distinct service, clinician or repeat-test justification.',
      lineIds: [...new Set([...lineIds('exact-duplicate'), ...lineIds('near-duplicate')])], effectCents: dupCents });
  }
  const ptpCents = ['ptp-no-exception', 'ptp-modifier-unverified', 'ptp-pair-review'].reduce((sum, kind) => sum + questioned(kind), 0);
  if (ptpCents) {
    plan.push({ id: 'unbundling', action: 'Ask whether the flagged component was already included in the paired service',
      rationale: 'A documented NCCI pair bills a component separately from its panel or procedure. The answer is a documentation question.',
      lineIds: [...new Set(['ptp-no-exception', 'ptp-modifier-unverified', 'ptp-pair-review'].flatMap(lineIds))], effectCents: ptpCents });
  }
  const mueCents = questioned('mue-units');
  if (mueCents) {
    plan.push({ id: 'units', action: 'Ask the biller to explain units above the selected reference cap',
      rationale: 'Units above a published medically unlikely edit deserve a written explanation.',
      lineIds: lineIds('mue-units'), effectCents: mueCents });
  }
  const mathCents = questioned('math-patient-total');
  if (report.balances.some(row => !row.matches)) {
    plan.push({ id: 'reconcile', action: 'Request a corrected statement that reconciles every total',
      rationale: 'At least one balance check failed; a corrected bill should make every total agree.',
      lineIds: [], effectCents: mathCents || null });
  }
  if (tree.coverage === 'insured') {
    plan.push({ id: 'network', action: 'Confirm the network status of every biller with the plan',
      rationale: 'The fixture does not record network status. Federal protections may limit out-of-network balances.',
      lineIds: [], effectCents: null });
  }
  plan.push({ id: 'verify', action: 'Match the itemized bill against visit records and the plan explanation',
    rationale: 'Every flagged line should correspond to a service that was actually delivered and documented.',
    lineIds: [], effectCents: null });
  plan.push({ id: 'assistance', action: 'Ask for the written financial assistance policy and application',
    rationale: 'IRS section 501(r) requires covered nonprofit hospitals to publish their policy. Eligibility varies by hospital.',
    lineIds: [], effectCents: null });
  return plan.map((item, index) => ({ priority: index + 1, ...item }));
}

export function recoverableRange(snapshot, coding, report = null) {
  const gross = coding.reduce((sum, item) => sum + item.questionedCents, 0);
  const lineById = new Map(snapshot.lines.map(line => [line.id, line]));
  const duplicateCopies = new Set();
  for (const item of coding) {
    if (item.kind !== 'exact-duplicate') continue;
    for (const id of item.lineIds.slice(1)) duplicateCopies.add(id);
  }
  const copyBilled = id => lineById.get(id)?.billed ?? 0;
  const exactIndependent = [...duplicateCopies].reduce((sum, id) => sum + copyBilled(id), 0);
  let independent = exactIndependent;
  let strong = exactIndependent;

  for (const item of coding) {
    if (item.kind === 'exact-duplicate') continue;
    const lines = item.lineIds.map(id => lineById.get(id)).filter(Boolean);
    let amount = item.questionedCents;
    if (item.kind === 'near-duplicate' && lines.length) {
      const minimum = Math.min(...lines.map(line => line.billed));
      const overlapping = lines.filter(line => duplicateCopies.has(line.id))
        .reduce((sum, line) => sum + Math.max(0, line.billed - minimum), 0);
      amount = Math.max(0, amount - overlapping);
    } else if (['ptp-no-exception', 'ptp-modifier-unverified', 'ptp-pair-review'].includes(item.kind)) {
      const target = lines[lines.length - 1];
      if (target && duplicateCopies.has(target.id)) amount = 0;
    } else if (item.kind === 'mue-units' && lines.length) {
      const totalUnits = lines.reduce((sum, line) => sum + line.units, 0);
      const limit = CATALOG[lines[0].code]?.mue?.[0];
      if (limit && totalUnits > limit) {
        const referenceUnit = report?.references?.find(row => row.id === lines[0].id)?.unitCents;
        const refUnit = referenceUnit ?? (item.questionedCents % (totalUnits - limit) === 0
          ? item.questionedCents / (totalUnits - limit)
          : roundHalfUp(item.questionedCents / (totalUnits - limit)));
        const duplicateUnits = lines.filter(line => duplicateCopies.has(line.id))
          .reduce((sum, line) => sum + line.units, 0);
        amount = Math.max(0, totalUnits - duplicateUnits - limit) * refUnit;
      }
    } else if (item.kind === 'gfe-threshold') {
      const scope = new Set(item.lineIds);
      const overlapping = [...duplicateCopies].filter(id => scope.has(id))
        .reduce((sum, id) => sum + copyBilled(id), 0);
      amount = Math.max(0, amount - overlapping);
      strong += amount;
    }
    independent += amount;
  }

  const overlapAdjustmentCents = Math.max(0, gross - independent);
  const cap = snapshot.totals.patient;
  const highCents = Math.min(independent, cap);
  const lowCents = Math.min(strong, highCents);
  return {
    lowCents, highCents, grossQuestionedCents: gross, overlapAdjustmentCents,
    basis: coding.length === 0
      ? 'Nothing was flagged on this fictional bill.'
      : `Questioned amounts, not a prediction: the low end counts only the strongest independent items. The high end counts exact-duplicate overlaps once before capping at the reported patient share.${overlapAdjustmentCents ? ` Gross questioned amount ${usd(gross)}; ${usd(overlapAdjustmentCents)} is shared by overlapping duplicate explanations.` : ''}`,
  };
}

export function disputeLetter(snapshot, analysis) {
  const info = CASES[snapshot.id];
  const lines = [
    'ClearBill fictional dispute letter - practice copy, not legal or billing advice.',
    `Ruleset ${RULESET}. Fictional case "${info.name}" (${snapshot.id.toUpperCase()}), ${LOCALITIES[snapshot.locality].name}.`,
    '',
    'Billing Office',
    `Re: Itemized bill dated ${snapshot.lines[0].day} - request for review`,
    '',
    'Dear Billing Office,',
    '',
    'I am reviewing the itemized bill above. Please treat this letter as a request for',
    'review, not as a refusal to pay a correct balance.',
    '',
  ];
  const actionable = analysis.plan.filter(item => item.effectCents);
  if (actionable.length) {
    lines.push('Questions about specific charges:');
    actionable.forEach((item, i) => {
      const ids = item.lineIds.length ? ` (${item.lineIds.map(id => id.replace('line-', 'L')).join(', ')})` : '';
      lines.push(`${i + 1}. ${item.action} Questioned amount ${usd(item.effectCents)}${ids}.`);
    });
  } else {
    lines.push('No specific charge was flagged. Please confirm the bill reconciles with my records.');
  }
  lines.push(
    '',
    'Please send a corrected itemized statement, the documentation supporting each',
    'questioned line, and the written financial assistance policy.',
    '',
    'Sincerely,',
    '[Your name]',
    '[Account number]',
    '',
  );
  return lines.join('\n');
}

// Full deterministic pipeline. Identical input produces byte-identical output.
export function analyzeBill(snapshot) {
  const report = audit(snapshot);
  const benchmark = benchmarkLines(snapshot, report);
  const coding = codingFindings(snapshot, report);
  const tree = coverageTree(snapshot, report);
  const plan = actionPlan(snapshot, report, tree, coding);
  const recoverable = recoverableRange(snapshot, coding, report);
  const letter = disputeLetter(snapshot, { plan });
  const stages = [
    { id: 'benchmark', title: 'Line benchmark scoring',
      result: `${benchmark.filter(row => row.band !== 'no-reference').length} of ${benchmark.length} lines priced against the clinician reference`,
      steps: benchmark.map(row => ({
        label: `${row.id.replace('line-', 'L')} / ${row.code}`,
        detail: row.band === 'no-reference'
          ? 'No separately priced clinician row; no ratio is inferred.'
          : `Charged ${usd(row.billed)} vs reference ${usd(row.referenceCents)}: markup ${(row.markupX100 / 100).toFixed(2)}x, z ${(row.zX100 / 100).toFixed(2)} (${row.band})${row.comparisonOnly ? ', comparison-only for a facility line' : ''}.`,
      })) },
    { id: 'coding', title: 'Coding-pattern findings',
      result: `${coding.filter(item => item.level === 'review').length} review flags, ${usd(coding.reduce((sum, item) => sum + item.questionedCents, 0))} questioned`,
      steps: coding.length ? coding.map(item => ({
        label: `${item.title} / ${item.rule}`,
        detail: `${item.detail} Confidence ${item.confidence} (${item.confidenceX100}/100). ${item.questionedCents ? `Questioned ${usd(item.questionedCents)}.` : 'No amount attached.'}`,
      })) : [{ label: 'Clean control', detail: 'No coding, duplicate, unit, arithmetic or estimate flag fired on this fictional bill.' }] },
    { id: 'coverage', title: 'Coverage protection tree',
      result: tree.outcomeReason,
      steps: tree.branches.map(branch => ({
        label: branch.question,
        detail: `${branch.answer.toUpperCase()} - ${branch.detail}`,
      })) },
    { id: 'plan', title: 'Appeal strategy',
      result: `${plan.length} prioritized steps; questioned range ${usd(recoverable.lowCents)} to ${usd(recoverable.highCents)}`,
      steps: plan.map(item => ({
        label: `${item.priority}. ${item.action}`,
        detail: `${item.rationale}${item.effectCents ? ` Questioned amount ${usd(item.effectCents)}.` : ''}`,
      })) },
  ];
  return {
    schema: REASONING_SCHEMA, ruleVersion: RULESET, caseId: snapshot.id, locality: snapshot.locality,
    benchmark, coding, tree, plan, recoverable, letter, digest: sha256Hex(letter), stages,
  };
}

export function normalizeSim(input) {
  const out = { ...DEFAULT_SIM };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(SLIDER_LIMITS)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = intIn(input[key], SLIDER_LIMITS[key][0], SLIDER_LIMITS[key][1]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// What-if negotiation simulator: transparent integer-cent sequential model.
export function simulateSettlement(snapshot, analysis, input) {
  const params = normalizeSim(input);
  const start = snapshot.totals.patient;
  const billed = snapshot.totals.billed;
  const questioned = analysis.recoverable.highCents;
  // Removing a questioned billed charge scales the patient share by patient/billed,
  // so a self-pay bill (patient == billed) removes the full questioned amount.
  const removal = billed > 0 ? roundHalfUp((questioned * params.removalPct * start) / (billed * 100)) : 0;
  const insurerAdj = roundHalfUp(((start - removal) * params.insurerPct) / 100);
  const discount = roundHalfUp(((start - removal - insurerAdj) * params.discountPct) / 100);
  const final = start - removal - insurerAdj - discount;
  return {
    params, start, questioned, removal, insurerAdj, discount, final, delta: start - final,
    waterfall: [
      { id: 'start', label: 'Reported patient', amount: start, from: 0, to: start, kind: 'total' },
      { id: 'removal', label: 'Disputed lines removed', amount: -removal, from: start - removal, to: start, kind: 'decrease' },
      { id: 'insurer', label: 'Insurer adjustment', amount: -insurerAdj, from: start - removal - insurerAdj, to: start - removal, kind: 'decrease' },
      { id: 'discount', label: 'Assistance and prompt-pay', amount: -discount, from: final, to: start - removal - insurerAdj, kind: 'decrease' },
      { id: 'final', label: 'Projected patient', amount: final, from: 0, to: final, kind: 'result' },
    ],
  };
}

// PII scrubber for the assist adapter and any user-supplied context text.
const PII_PATTERNS = Object.freeze([
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  ['phone', /\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, '[phone]'],
  ['date', /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '[date]'],
  ['label', /\b(name|patient|subscriber|member|insured|claim|account|mrn|dob)\s*[:=]\s*[^\n,;]{1,80}/gi, '$1: [redacted]'],
  ['id', /\b\d{7,}\b/g, '[id]'],
]);

export function scrubPii(text) {
  const hits = {};
  let out = String(text ?? '');
  for (const [kind, pattern, replacement] of PII_PATTERNS) {
    out = out.replace(pattern, (...args) => {
      hits[kind] = (hits[kind] || 0) + 1;
      return replacement.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? '');
    });
  }
  return { text: out, hits };
}

// Structured payload for a user-supplied OpenAI-compatible chat endpoint.
// The payload carries fictional identifiers only; ClearBill never sends it.
export function buildAssistPayload(analysis, options = {}) {
  const context = scrubPii(options.contextText ?? '');
  const endpoint = typeof options.endpoint === 'string' ? options.endpoint.trim() : '';
  const model = typeof options.model === 'string' ? options.model.trim().slice(0, 120) : '';
  const summary = {
    caseName: CASES[analysis.caseId].name,
    locality: LOCALITIES[analysis.locality].name,
    coverage: analysis.tree.coverage,
    outcome: analysis.tree.outcome,
    findings: analysis.coding.map(item => ({ kind: item.kind, rule: item.rule, lines: item.lineIds, questionedCents: item.questionedCents })),
    plan: analysis.plan.map(item => ({ priority: item.priority, action: item.action, effectCents: item.effectCents })),
    questionedRange: { lowCents: analysis.recoverable.lowCents, highCents: analysis.recoverable.highCents },
    letterDraft: analysis.letter,
    letterDigest: analysis.digest,
  };
  const userContent = `Rewrite this fictional dispute draft into a plain-English call prep.\n\n${JSON.stringify(summary, null, 1)}`
    + (context.text ? `\n\nUser context (scrubbed): ${context.text}` : '');
  return {
    schema: ASSIST_SCHEMA,
    disclosure: 'Fictional educational data only. Deterministic local analysis, not an AI completion. Not legal, medical or billing advice.',
    transport: {
      note: 'Paste this payload into your own client or POST it to your own OpenAI-compatible chat endpoint. ClearBill performs no network call.',
      endpoint, model: model || 'your-model',
    },
    request: {
      model: model || 'your-model',
      messages: [
        { role: 'system', content: 'You are a careful billing-literacy explainer. The data is fictional teaching material. Never give legal, medical or payment directives; explain options and questions.' },
        { role: 'user', content: userContent },
      ],
    },
    scrubReport: context.hits,
  };
}

export function validateEndpoint(url) {
  if (typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'empty' };
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: 'no-credentials' };
  const host = parsed.hostname.toLowerCase();
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.localhost');
  if (parsed.protocol === 'http:') return loopback ? { ok: true, reason: 'loopback' } : { ok: false, reason: 'https-required' };
  if (parsed.protocol === 'https:') return { ok: true, reason: 'https' };
  return { ok: false, reason: 'invalid' };
}

export function selfTests() {
  return [
    ['determinism', () => {
      for (const id of Object.keys(CASES)) {
        check(canonical(analyzeBill(fixtureFor(id))) === canonical(analyzeBill(fixtureFor(id))), `${id} replay`);
      }
    }],
    ['benchmark', () => {
      const analysis = analyzeBill(fixtureFor('demo-er'));
      const facility = analysis.benchmark.find(row => row.id === 'line-1');
      check(facility.markupX100 === 1201 && facility.band === 'outlier', 'hospital facility markup 12.01x outlier');
      const pro = analysis.benchmark.find(row => row.id === 'line-2');
      check(pro.markupX100 === 373 && pro.zX100 === 38 && pro.band === 'typical', 'professional markup 3.73x z 0.38');
      check(analysis.benchmark.filter(row => row.band === 'no-reference').length === 2, 'two unpriced lab lines');
    }],
    ['coding-kinds', () => {
      const coding = analyzeBill(fixtureFor('demo-er')).coding;
      check(coding.map(item => item.kind).join(',') === 'exact-duplicate,near-duplicate,ptp-pair-review,mue-units', 'ER finding kinds in order');
      check(coding.every(item => item.rule && item.rationale && item.confidenceX100 >= 0), 'every finding carries rule, rationale and confidence');
    }],
    ['questioned', () => {
      const coding = analyzeBill(fixtureFor('demo-er')).coding;
      const by = kind => coding.find(item => item.kind === kind).questionedCents;
      check(by('exact-duplicate') === 12000, 'exact duplicate questions one extra copy at $120.00');
      check(by('near-duplicate') === 800, 'near duplicate questions the spread above the minimum');
      check(by('ptp-pair-review') === 3900, 'column-two component questioned at its charge');
      check(by('mue-units') === 1018, 'one excess unit priced at the facility 26 reference');
    }],
    ['tree', () => {
      check(analyzeBill(fixtureFor('demo-imaging')).tree.outcome === 'potential-ppdr', 'self-pay fixture passes all screens');
      check(analyzeBill(fixtureFor('demo-er')).tree.outcome === 'nsa-emergency-review', 'insured ER routes to emergency review');
      check(analyzeBill(fixtureFor('demo-clean')).tree.outcome === 'nsa-ancillary-review', 'insured office routes to ancillary review');
      const forged = fixtureFor('demo-imaging');
      const forgedReport = audit(forged);
      check(coverageTree(forged, { ...forgedReport, estimate: { ...forgedReport.estimate, state: 'outside-window', elapsed: 121 } }).outcome === 'gfe-outside-window', 'elapsed 121 exits the window');
      const low = fixtureFor('demo-imaging');
      low.lines[0].billed = 100000;
      check(analyzeBill(low).tree.outcome === 'gfe-below-threshold', 'gap 35000 below the screen');
      const off = fixtureFor('demo-imaging');
      off.gfe.election = false;
      check(analyzeBill(off).tree.outcome === 'gfe-prerequisites', 'election missing fails prerequisites');
      const noEst = fixtureFor('demo-imaging');
      noEst.gfe = null;
      check(analyzeBill(noEst).tree.outcome === 'gfe-unavailable', 'no estimate short-circuits the tree');
    }],
    ['plan-order', () => {
      const plan = analyzeBill(fixtureFor('demo-er')).plan;
      check(plan[0].id === 'duplicates' && plan[0].priority === 1, 'strongest ER step first');
      check(plan.every((item, i) => item.priority === i + 1), 'priorities are sequential');
      check(plan.some(item => item.id === 'assistance') && plan.some(item => item.id === 'verify'), 'assistance and verification always present');
      check(analyzeBill(fixtureFor('demo-imaging')).plan[0].id === 'ppdr', 'PPDR leads the self-pay plan');
    }],
    ['recoverable', () => {
      const er = analyzeBill(fixtureFor('demo-er')).recoverable;
      check(er.lowCents === 12000 && er.highCents === 16300 && er.overlapAdjustmentCents === 1418, 'ER overlap-aware range 12000-16300');
      const img = analyzeBill(fixtureFor('demo-imaging')).recoverable;
      check(img.lowCents === 47500 && img.highCents === 47500, 'imaging range equals the gap');
      const clean = analyzeBill(fixtureFor('demo-clean')).recoverable;
      check(clean.lowCents === 0 && clean.highCents === 0, 'clean bill questions nothing');
    }],
    ['simulate', () => {
      const snapshot = fixtureFor('demo-er');
      const analysis = analyzeBill(snapshot);
      const zero = simulateSettlement(snapshot, analysis, { removalPct: 0, insurerPct: 0, discountPct: 0 });
      check(zero.final === zero.start && zero.delta === 0, 'all-zero sliders leave the patient share untouched');
      const full = simulateSettlement(snapshot, analysis, { removalPct: 100, insurerPct: 50, discountPct: 90 });
      check(full.final >= 0 && full.final < full.start, 'full sliders reduce but never invert');
      const er = simulateSettlement(snapshot, analysis, { removalPct: 100, insurerPct: 10, discountPct: 25 });
      check(er.removal === 1993 && er.insurerAdj === 2801 && er.discount === 6302 && er.final === 18904, 'ER waterfall exact cents');
      const img = simulateSettlement(fixtureFor('demo-imaging'), analyzeBill(fixtureFor('demo-imaging')), { removalPct: 100, insurerPct: 0, discountPct: 0 });
      check(img.removal === 47500 && img.final === img.start - 47500, 'self-pay removal is dollar-for-dollar');
      check(img.waterfall[4].amount === img.final, 'waterfall ends at the projection');
    }],
    ['scrub', () => {
      const scrub = scrubPii('Email a.b+x@example.org, SSN 123-45-6789, call (555) 010-2030, patient: Jane Doe, MRN: 445566, born 01/02/2011');
      check(!/[0-9]{7,}|@|\d{3}-\d{2}-\d{4}|\(555\)|Jane Doe/.test(scrub.text), 'no residual pattern');
      check(scrub.hits.email === 1 && scrub.hits.ssn === 1 && scrub.hits.phone === 1 && scrub.hits.label === 2 && scrub.hits.date === 1, 'hit counts');
      check(scrubPii(null).text === '' && scrubPii('plain text').text === 'plain text', 'tolerates empty and clean input');
    }],
    ['payload', () => {
      const payload = buildAssistPayload(analyzeBill(fixtureFor('demo-er')), { contextText: 'call 555-010-2030' });
      const flat = canonical(payload.request);
      check(payload.schema === ASSIST_SCHEMA && payload.request.messages.length === 2, 'schema and two messages');
      check(!flat.includes('@') && !flat.includes('555-010-2030'), 'no PII survives into the request');
      check(flat.includes('questionedCents'), 'structured analysis embedded');
    }],
    ['endpoint', () => {
      for (const [url, ok] of [
        ['https://api.example.com/v1/chat/completions', true], ['http://localhost:11434/v1/chat', true],
        ['http://127.0.0.1:8080/chat', true], ['http://api.example.com', false],
        ['https://user:pass@api.example.com', false], ['ftp://example.com', false], ['not a url', false], ['', false],
      ]) {
        check(validateEndpoint(url).ok === ok, `endpoint ${url || '(empty)'}`);
      }
    }],
    ['letter', () => {
      const analysis = analyzeBill(fixtureFor('demo-er'));
      check(/^[a-f0-9]{64}$/.test(analysis.digest), 'letter digest is SHA-256 hex');
      check(sha256Hex(analysis.letter) === analysis.digest, 'digest matches the letter bytes');
      check(analysis.letter.includes('Questioned amount $128.00') && analysis.letter.includes('$39.00') && analysis.letter.includes('$10.18'), 'letter embeds exact questioned amounts');
      check(!/[\u2013\u2014]/.test(analysis.letter), 'letter uses plain hyphens only');
    }],
  ].map(([id, run]) => ({ id, run }));
}

const fixtureFor = id => createCase(id);

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountReasoningLab(panel) {
  const doc = panel?.ownerDocument;
  const win = doc?.defaultView;
  const $ = id => doc.getElementById(id);
  for (const id of ['reason-summary', 'reason-trace', 'reason-removal', 'reason-insurer', 'reason-discount',
    'reason-removal-out', 'reason-insurer-out', 'reason-discount-out', 'reason-delta', 'reason-waterfall',
    'reason-plan', 'reason-letter', 'reason-digest', 'reason-status', 'reason-letter-copy', 'reason-letter-download',
    'assist-endpoint', 'assist-model', 'assist-context', 'assist-build', 'assist-copy', 'assist-download',
    'assist-payload', 'assist-status', 'reason-run', 'reason-test-list', 'reason-test-status']) {
    if (!doc || !$(id)) throw new Error('Reasoning lab markup is missing.');
  }

  let analysis = null;
  let snapshot = null;
  let sim = { ...DEFAULT_SIM };
  let payload = null;
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
  const announce = text => { $('reason-status').textContent = text; };

  const BAND_TONE = Object.freeze({
    outlier: 'brick', elevated: 'amber', typical: 'cobalt', 'at-reference': 'forest', 'no-reference': 'muted',
  });
  const ANSWER_TONE = Object.freeze({ yes: 'forest', no: 'brick', unknown: 'amber' });
  const CONFIDENCE_TONE = Object.freeze({ high: 'brick', moderate: 'amber', exploratory: 'cobalt' });
  const pill = (text, tone) => {
    const node = el('span', text, 'reason-pill');
    node.dataset.tone = tone;
    return node;
  };

  function summary() {
    const dl = el('dl', '', 'reason-cards');
    const reviewFlags = analysis.coding.filter(item => item.level === 'review').length;
    const clean = analysis.recoverable.highCents === 0 && analysis.recoverable.lowCents === 0;
    const entries = [
      ['Questioned range', clean ? 'None flagged' : `${usd(analysis.recoverable.lowCents)} to ${usd(analysis.recoverable.highCents)}`,
        clean ? 'forest' : 'brick', 'figure'],
      ['Protection outcome', analysis.tree.outcome, 'cobalt', 'code'],
      ['Review flags', `${reviewFlags}`, reviewFlags ? 'amber' : 'forest', 'figure'],
      ['Case', `${CASES[analysis.caseId].name} / ${LOCALITIES[analysis.locality].name}`, 'ink', 'text'],
    ];
    for (const [name, value, tone, kind] of entries) {
      const card = el('div', '', 'reason-card');
      card.dataset.tone = tone;
      card.dataset.kind = kind;
      card.append(el('dt', name), el('dd', value));
      dl.append(card);
    }
    $('reason-summary').replaceChildren(dl, el('p', analysis.recoverable.basis, 'ledger-note reason-basis'));
  }

  // Markup gauge: the bill's charge as a multiple of the clinician reference, with a 1x reference tick.
  function gauge(row, maxX100) {
    const svg = svgEl('svg', { class: 'reason-gauge', viewBox: '0 0 200 10', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    svg.append(svgEl('rect', { class: 'reason-gauge-track', x: 0, y: 2, width: 200, height: 6, rx: 1 }));
    const w = Math.max(2, Math.min(200, (row.markupX100 / maxX100) * 200));
    const fill = svgEl('rect', { class: 'reason-gauge-fill', x: 0, y: 2, width: w.toFixed(1), height: 6, rx: 1 });
    fill.dataset.tone = BAND_TONE[row.band] || 'muted';
    svg.append(fill, svgEl('rect', { class: 'reason-gauge-tick', x: ((100 / maxX100) * 200 - 0.75).toFixed(1), y: 0, width: 1.5, height: 10 }));
    return svg;
  }

  function stageRows(stage) {
    const maxX100 = Math.max(200, ...analysis.benchmark.map(row => row.markupX100 ?? 0));
    const list = el('ul', '', 'reason-rows');
    list.setAttribute('aria-label', `${stage.title} evidence`);
    stage.steps.forEach((step, i) => {
      const li = el('li', '', 'reason-row');
      const head = el('div', '', 'reason-row-head');
      head.append(el('span', step.label, 'reason-row-label'));
      const detail = el('p', '', 'reason-row-detail');
      let meter = null;
      if (stage.id === 'benchmark' && analysis.benchmark[i]) {
        const row = analysis.benchmark[i];
        head.append(pill(row.band.replace('-', ' '), BAND_TONE[row.band] || 'muted'));
        if (row.markupX100 !== null) meter = gauge(row, maxX100);
        detail.textContent = step.detail;
      } else if (stage.id === 'coding' && analysis.coding[i]) {
        const item = analysis.coding[i];
        head.append(pill(`${item.confidence} ${item.confidenceX100}/100`, CONFIDENCE_TONE[item.confidence] || 'muted'));
        detail.textContent = step.detail;
      } else if (stage.id === 'coverage' && analysis.tree.branches[i]) {
        const branch = analysis.tree.branches[i];
        // The pill carries the answer; a visually hidden separator keeps the sentence intact for assistive tech.
        head.append(pill(branch.answer.toUpperCase(), ANSWER_TONE[branch.answer] || 'muted'));
        detail.append(el('span', ' - ', 'sr-only'), branch.detail);
      } else if (stage.id === 'plan' && analysis.plan[i]) {
        const item = analysis.plan[i];
        if (item.effectCents) head.append(pill(usd(item.effectCents), 'brick'));
        detail.textContent = step.detail;
      } else {
        if (stage.id === 'coding') head.append(pill('clean', 'forest'));
        detail.textContent = step.detail;
      }
      li.append(head);
      if (meter) li.append(meter);
      li.append(detail);
      list.append(li);
    });
    return list;
  }

  function stageMetric(stage) {
    if (stage.id === 'benchmark') {
      const outliers = analysis.benchmark.filter(row => row.band === 'outlier').length;
      return pill(`${outliers} outlier${outliers === 1 ? '' : 's'}`, outliers ? 'brick' : 'forest');
    }
    if (stage.id === 'coding') {
      const flags = analysis.coding.filter(item => item.level === 'review').length;
      return pill(`${flags} flag${flags === 1 ? '' : 's'}`, flags ? 'amber' : 'forest');
    }
    if (stage.id === 'coverage') {
      const open = analysis.tree.branches.filter(branch => branch.answer === 'unknown').length;
      return pill(open ? `${open} unknown` : 'screens answered', open ? 'amber' : 'forest');
    }
    return pill(`${analysis.plan.length} steps`, 'ink');
  }

  function trace() {
    $('reason-trace').replaceChildren(...analysis.stages.map((stage, index) => {
      const li = el('li', '', 'reason-stage');
      li.dataset.stage = stage.id;
      const node = el('span', String(index + 1).padStart(2, '0'), 'reason-node');
      node.setAttribute('aria-hidden', 'true');
      const body = el('div', '', 'reason-stage-body');
      const head = el('div', '', 'reason-stage-head');
      head.append(el('h3', stage.title), stageMetric(stage));
      const evidence = el('details', '', 'reason-evidence');
      evidence.open = stage.id !== 'plan';
      evidence.append(el('summary', `Evidence (${stage.steps.length})`), stageRows(stage));
      body.append(head, el('p', stage.result, 'reason-stage-result'), evidence);
      li.append(node, body);
      return li;
    }));
  }

  let chartWidth = 0;
  function waterfall(simResult) {
    const host = $('reason-waterfall');
    const measured = Math.round(host.clientWidth || 0);
    const style = win.getComputedStyle(host);
    const inner = measured - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const width = Math.max(300, Math.min(760, inner > 0 ? Math.floor(inner) : 660));
    chartWidth = measured;
    const compact = width < 520;
    const bars = simResult.waterfall;
    const barH = compact ? 22 : 36;
    const rowH = compact ? barH + 30 : barH + 32;
    const top = compact ? 22 : 10;
    const labelW = compact ? 0 : 190;
    const gutter = compact ? 8 : 84;
    const plotW = width - labelW - gutter;
    const axisY = top + bars.length * rowH - (compact ? 4 : 6);
    const height = axisY + 26;
    const scale = simResult.start > 0 ? plotW / simResult.start : 0;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img',
      'aria-label': 'Projected patient share waterfall', class: compact ? 'wf-compact' : 'wf-wide' });

    // Gridlines at a round dollar step (1, 2, 2.5 or 5 times a power of ten), about four across.
    const rawStep = simResult.start / 4;
    const magnitude = rawStep > 0 ? 10 ** Math.floor(Math.log10(rawStep)) : 1;
    const step = rawStep > 0 ? [1, 2, 2.5, 5, 10].map(f => f * magnitude).find(v => v >= rawStep) : 1;
    for (let value = 0; rawStep > 0 && value <= simResult.start + 0.5; value += step) {
      const x = labelW + value * scale;
      svg.append(svgEl('line', { class: 'chart-grid wf-grid', x1: x, y1: top - (compact ? 16 : 4), x2: x, y2: axisY }));
      const tick = svgEl('text', { class: 'chart-label wf-tick', x, y: axisY + 17,
        'text-anchor': value === 0 ? 'start' : x > labelW + plotW - 24 ? 'end' : 'middle' });
      tick.textContent = usd(Math.round(value)).replace(/\.00$/, '');
      svg.append(tick);
    }

    const barTop = row => top + row * rowH + (compact ? 4 : 0);
    bars.forEach((bar, row) => {
      const x = labelW + Math.min(bar.from, bar.to) * scale;
      const w = Math.max(Math.abs(bar.to - bar.from) * scale, 2);
      const y = barTop(row);
      if (row < bars.length - 1) {
        const next = bars[row + 1];
        const level = bar.kind === 'total' ? bar.to : bar.from;
        const cx = labelW + level * scale;
        svg.append(svgEl('line', { class: 'wf-connector', x1: cx, y1: y + barH, x2: cx, y2: barTop(row + 1) }));
      }
      const g = svgEl('g', { class: 'chart-bar wf-bar', tabindex: '0', role: 'img',
        'aria-label': `${bar.label}: ${usd(Math.abs(bar.amount))}` });
      g.append(svgEl('rect', { class: 'bar-ring', x: x - 3, y: y - 3, width: w + 6, height: barH + 6, rx: 3 }));
      g.append(svgEl('rect', { class: `wf-${bar.kind}`, x, y, width: w, height: barH, rx: 2 }));
      const value = `${bar.amount < 0 ? '-' : ''}${usd(Math.abs(bar.amount))}`;
      const label = svgEl('text', compact
        ? { class: 'chart-label wf-label', x: 0, y: y - 7 }
        : { class: 'chart-label wf-label', x: 0, y: y + barH / 2 + 4.5 });
      label.textContent = bar.label;
      const val = svgEl('text', compact
        ? { class: `chart-value wf-value wf-value-${bar.kind}`, x: width, y: y - 7, 'text-anchor': 'end' }
        : { class: `chart-value wf-value wf-value-${bar.kind}`, x: x + w + 8, y: y + barH / 2 + 4.5 });
      val.textContent = value;
      g.append(label, val);
      svg.append(g);
    });
    svg.append(svgEl('line', { class: 'chart-axis', x1: labelW, y1: axisY, x2: labelW + plotW, y2: axisY }));
    host.replaceChildren(svg);
  }

  let lastResult = null;
  function simulate() {
    const result = simulateSettlement(snapshot, analysis, sim);
    lastResult = result;
    for (const [id, key, max] of [['reason-removal', 'removalPct', 100], ['reason-insurer', 'insurerPct', 50], ['reason-discount', 'discountPct', 90]]) {
      $(`${id}-out`).value = `${sim[key]}%`;
      $(id).style.setProperty('--fill', `${(sim[key] / max) * 100}%`);
    }
    const line = el('p', '', 'reason-delta-line');
    line.append(
      el('span', 'Projected patient share', 'reason-delta-label'), ' ',
      el('strong', usd(result.final), 'reason-delta-figure'), ' ',
      el('span', '(', 'sr-only'),
      el('span', `down ${usd(result.delta)}`, 'reason-delta-down'),
      el('span', ` from ${usd(result.start)}`, 'reason-delta-from'),
      el('span', ').', 'sr-only'));
    const meter = svgEl('svg', { class: 'reason-delta-meter', viewBox: '0 0 200 6', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    const share = result.start > 0 ? (result.final / result.start) * 200 : 0;
    meter.append(svgEl('rect', { class: 'reason-delta-meter-track', x: 0, y: 0, width: 200, height: 6 }),
      svgEl('rect', { class: 'reason-delta-meter-fill', x: 0, y: 0, width: share.toFixed(1), height: 6 }));
    const card = el('div', '', 'reason-delta-card');
    card.append(line, meter,
      el('p', `Educational model: removal scales the reported patient share in proportion to billed charges, then the two percentage sliders apply in sequence. It is not a prediction or an offer.`, 'ledger-note'));
    $('reason-delta').replaceChildren(card);
    waterfall(result);
  }

  function planView() {
    const list = el('ol', '', 'reason-plan-list');
    for (const item of analysis.plan) {
      const li = el('li', '', 'reason-plan-item');
      const badge = el('span', `P${item.priority}`, 'plan-priority');
      const body = el('div', '', 'plan-body');
      body.append(el('h3', item.action), el('p', item.rationale));
      if (item.effectCents) body.append(el('p', `Questioned amount ${usd(item.effectCents)}.`, 'plan-effect'));
      li.append(badge, body);
      list.append(li);
    }
    $('reason-plan').replaceChildren(list);
  }

  function letterView() {
    $('reason-letter').textContent = analysis.letter;
    $('reason-digest').replaceChildren(el('span', 'SHA-256', 'reason-digest-label'), ' ', el('span', analysis.digest, 'reason-digest-hash'));
  }

  function render() {
    summary();
    trace();
    simulate();
    planView();
    letterView();
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

  async function copy(text, okMessage, field, statusId = 'reason-status') {
    try {
      await win.navigator.clipboard.writeText(text);
      $(statusId).textContent = okMessage;
    } catch {
      field?.focus();
      field?.select?.();
      $(statusId).textContent = 'Select the text and copy it.';
    }
  }

  for (const [id, key] of [['reason-removal', 'removalPct'], ['reason-insurer', 'insurerPct'], ['reason-discount', 'discountPct']]) {
    $(id).addEventListener('input', () => {
      sim = { ...sim, [key]: $(id).valueAsNumber };
      simulate();
    });
  }
  $('reason-controls')?.addEventListener('submit', event => event.preventDefault());
  let resizeFrame = 0;
  win.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = win.requestAnimationFrame(() => {
      resizeFrame = 0;
      const host = $('reason-waterfall');
      if (lastResult && host.clientWidth && Math.round(host.clientWidth) !== chartWidth) waterfall(lastResult);
    });
  });
  $('reason-letter-print')?.addEventListener('click', () => {
    const detail = $('reason-letter-detail');
    if (detail) detail.open = true;
    const previous = doc.body.dataset.print || '';
    doc.body.dataset.print = 'letter';
    win.addEventListener('afterprint', () => { doc.body.dataset.print = previous; }, { once: true });
    win.print();
    announce('Print dialog opened for the letter.');
  });
  $('reason-letter-copy').addEventListener('click', () => copy(analysis.letter, 'Letter copied to the clipboard.', $('reason-letter')));
  $('reason-letter-download').addEventListener('click', () => {
    download(`clearbill-${snapshot.id}-dispute-letter.txt`, `${analysis.letter}\nSHA-256 ${analysis.digest}\n`, 'text/plain;charset=utf-8');
    announce('Letter downloaded with its SHA-256 digest.');
  });
  $('assist-build').addEventListener('click', () => {
    const endpoint = $('assist-endpoint').value.trim();
    const verdict = validateEndpoint(endpoint);
    payload = buildAssistPayload(analysis, {
      endpoint, model: $('assist-model').value, contextText: $('assist-context').value,
    });
    $('assist-payload').value = `${JSON.stringify(payload, null, 1)}\n`;
    $('assist-copy').disabled = false;
    $('assist-download').disabled = false;
    const scrub = Object.entries(payload.scrubReport).map(([kind, count]) => `${count} ${kind}`).join(', ');
    const gate = !endpoint ? 'No endpoint set: the payload is export-only.'
      : verdict.ok ? `Endpoint looks sendable (${verdict.reason}). ClearBill still sends nothing itself.`
      : `Endpoint rejected (${verdict.reason}). Export only.`;
    $('assist-status').textContent = `${gate}${scrub ? ` Scrubbed: ${scrub}.` : ''}`;
  });
  $('assist-copy').addEventListener('click', () => copy($('assist-payload').value, 'Payload copied to the clipboard.', $('assist-payload'), 'assist-status'));
  $('assist-download').addEventListener('click', () => {
    if (!payload) return;
    download(`clearbill-${snapshot.id}-assist-payload.json`, `${JSON.stringify(payload, null, 1)}\n`, 'application/json');
    $('assist-status').textContent = 'Payload downloaded. Send it from your own client with your own key.';
  });
  $('reason-run').addEventListener('click', () => {
    const results = selfTests().map(item => {
      try {
        item.run();
        return { ...item, pass: true };
      } catch (error) {
        return { ...item, pass: false, error: error.message };
      }
    });
    $('reason-test-list').replaceChildren(...results.map(result => {
      const li = el('li', '', result.pass ? 'test-pass' : 'test-fail');
      li.dataset.pass = String(result.pass);
      li.append(el('span', `${result.pass ? 'PASS' : 'FAIL'}`, 'test-mark'), el('span', result.id, 'test-name'),
        result.pass ? '' : el('span', result.error, 'test-error'));
      return li;
    }));
    const passing = results.filter(result => result.pass).length;
    $('reason-test-status').textContent = `${passing}/${results.length} passing`;
    $('reason-test-status').dataset.all = String(passing === results.length);
  });

  return {
    update(nextSnapshot) {
      snapshot = nextSnapshot;
      analysis = analyzeBill(snapshot);
      render();
      return analysis;
    },
    getAnalysis: () => analysis,
  };
}
