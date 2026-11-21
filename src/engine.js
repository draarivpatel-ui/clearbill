import { CASES, CATALOG, CONVERSION_1E4, DISTINCT_MODIFIERS, ENTITY, EVIDENCE, LOCALITIES, MODIFIERS, PTP, RULESET, SERVICE_DATES } from './data.js';

export const MAX_CENTS = 100_000_000;
export const MAX_UNITS = 500;
const fields = ['billed', 'adjustment', 'allowed', 'deductible', 'coinsurance', 'copay', 'insurer', 'patient'];
const settings = ['office', 'facility'];
const practitioners = ['demo-provider', 'demo-lab', 'demo-imaging'];
const dayMs = 86_400_000;

const record = (value, keys) => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const bounded = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const cents = value => bounded(value, 0, MAX_CENTS);

function assert(valid, detail) {
  if (!valid) throw new TypeError(detail);
}

function utcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? +date / dayMs : NaN;
}

export function validSelection(id, locality) {
  return typeof id === 'string' && Object.hasOwn(CASES, id)
    && typeof locality === 'string' && Object.hasOwn(LOCALITIES, locality);
}

export function validateSnapshot(snapshot) {
  assert(record(snapshot, ['id', 'locality', 'lines', 'totals', 'gfe'])
    && validSelection(snapshot.id, snapshot.locality), 'Expected a known fictional case and locality.');
  assert(Array.isArray(snapshot.lines) && bounded(snapshot.lines.length, 1, 32), 'Expected 1 to 32 fictional lines.');
  const seen = new Set();
  for (const line of snapshot.lines) {
    assert(record(line, ['id', 'day', 'code', 'entity', 'setting', 'units', 'billed', 'modifiers', 'evidence'])
      && typeof line.id === 'string' && /^line-(?:[1-9]|[12][0-9]|3[0-2])$/.test(line.id)
      && !seen.has(line.id) && SERVICE_DATES.includes(line.day)
      && typeof line.code === 'string' && Object.hasOwn(CATALOG, line.code)
      && typeof line.entity === 'string' && Object.hasOwn(ENTITY, line.entity)
      && settings.includes(line.setting) && bounded(line.units, 1, MAX_UNITS) && cents(line.billed)
      && EVIDENCE.includes(line.evidence) && Array.isArray(line.modifiers)
      && line.modifiers.length <= 4 && new Set(line.modifiers).size === line.modifiers.length
      && (line.modifiers.includes('26') + line.modifiers.includes('TC') <= 1),
    'Invalid fictional line, code, modifier count, units or amount.');
    assert([...line.modifiers].every(modifier => MODIFIERS.includes(modifier)), 'Unknown fictional modifier.');
    seen.add(line.id);
  }
  assert(record(snapshot.totals, fields) && fields.every(key => cents(snapshot.totals[key])), 'Invalid summary amounts.');
  const { gfe } = snapshot;
  assert(gfe === null || (
    snapshot.id === 'demo-imaging' && record(gfe, ['entity', 'estimated', 'election', 'estimateBeforeCare', 'initialBill', 'checkedOn'])
    && typeof gfe.entity === 'string' && Object.hasOwn(ENTITY, gfe.entity) && cents(gfe.estimated)
    && typeof gfe.election === 'boolean' && typeof gfe.estimateBeforeCare === 'boolean'
    && gfe.initialBill === '2026-10-29' && gfe.checkedOn === '2026-11-10'
  ), 'Invalid estimate or fictional dates.');
  return snapshot;
}

export function parseDollars(value) {
  if (typeof value !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents(result) ? result : null;
}

export function usd(amount) {
  const absolute = Math.abs(amount);
  const whole = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0 ? '-' : ''}$${whole}.${String(absolute % 100).padStart(2, '0')}`;
}

export function calculateReference(code, locality, setting, component = 'base') {
  assert(typeof code === 'string' && Object.hasOwn(CATALOG, code), 'Unknown reference code.');
  assert(typeof locality === 'string' && Object.hasOwn(LOCALITIES, locality) && settings.includes(setting)
    && ['base', '26', 'TC'].includes(component), 'Unknown reference configuration.');
  const row = CATALOG[code].rows[component];
  const pe = row?.[setting === 'facility' ? 2 : 1];
  if (!row || pe === null) return { available: false, reason: !row ? 'not-listed' : 'setting-not-applicable' };
  const rvu = [row[0], pe, row[3]];
  const gpci = LOCALITIES[locality].gpci;
  const products = rvu.map((value, i) => value * gpci[i]);
  // Products are RVU x 100,000. Multiply by CF x 10,000, then round to cents once.
  const numerator = BigInt(products.reduce((sum, value) => sum + value, 0)) * BigInt(CONVERSION_1E4);
  return {
    available: true, code, locality, setting, component, rvu, gpci: [...gpci], products,
    conversion: CONVERSION_1E4, cents: Number((numerator + 5_000_000n) / 10_000_000n),
  };
}

function lineReference(line, locality) {
  const component = line.modifiers.find(value => value === '26' || value === 'TC') || 'base';
  const result = calculateReference(line.code, locality, line.setting, component);
  return result.available ? {
    unitCents: result.cents,
    lineCents: result.cents * line.units,
    comparisonOnly: line.entity === 'demo-hospital',
  } : { unitCents: null, lineCents: null, comparisonOnly: false, reason: result.reason };
}

export function compareEstimate({ estimated, billed, election, estimateBeforeCare, initialBill, checkedOn, serviceDay }) {
  if (!cents(estimated) || !bounded(billed, 0, 32 * MAX_CENTS)) return { state: 'unavailable' };
  const gap = billed - estimated;
  const elapsed = utcDay(checkedOn) - utcDay(initialBill);
  const service = utcDay(serviceDay);
  const dateOk = Number.isFinite(elapsed) && Number.isFinite(service)
    && service >= utcDay('2022-01-01') && service <= utcDay(initialBill) && elapsed >= 0;
  const status = { gap, elapsed: dateOk ? elapsed : null, threshold: 40000, meetsAmount: gap >= 40000 };
  if (election !== true || estimateBeforeCare !== true || !dateOk) return { state: 'missing-prerequisites', ...status };
  if (!status.meetsAmount) return { state: 'below-threshold', ...status };
  if (elapsed > 120) return { state: 'outside-window', ...status };
  return { state: 'potential-ppdr', ...status };
}

const fplTable = Object.freeze({ contiguous: [1596000, 568000], alaska: [1995000, 710000], hawaii: [1836000, 653000] });

export function screenFpl(region, size, annualIncome) {
  assert(typeof region === 'string' && Object.hasOwn(fplTable, region) && bounded(size, 1, 50)
    && cents(annualIncome), 'Choose a region, household size 1 to 50 and a fictional annual income.');
  const [base, increment] = fplTable[region];
  const guideline = base + (size - 1) * increment;
  // Compare unrounded values; the displayed percent is rounded to one decimal.
  const percentTenths = Math.floor((annualIncome * 2000 + guideline) / (guideline * 2));
  const band = annualIncome <= guideline * 2 ? 'at-or-below-200' : annualIncome <= guideline * 4 ? 'at-or-below-400' : 'above-400';
  return { year: 2026, guideline, percentTenths, band };
}

const modifierEvidence = Object.freeze({
  59: ['encounter', 'site', 'nonoverlap'], XE: ['encounter'], XS: ['site'], XP: ['practitioner'], XU: ['nonoverlap'],
  91: ['repeat-lab'], 76: ['encounter'], 77: ['practitioner'],
});

function quality(line, permitted, support) {
  const reported = line.modifiers.filter(modifier => permitted.includes(modifier));
  const documented = reported.filter(modifier => modifierEvidence[modifier]?.includes(line.evidence)
    && (support === undefined || support.includes(line.evidence)));
  return { reported, documented };
}

export function assessPair(columnOne, columnTwo, ccmi, context) {
  if (ccmi === 9) return 'inactive';
  if (ccmi === 0) return 'no-exception';
  assert(ccmi === 1, 'Unknown modifier indicator.');
  const isLab = context === 'laboratory';
  const permitted = isLab ? [...DISTINCT_MODIFIERS] : DISTINCT_MODIFIERS.filter(modifier => modifier !== '91');
  const evidence = isLab ? ['encounter', 'repeat-lab'] : ['encounter', 'site', 'practitioner', 'nonoverlap'];
  const a = quality(columnOne, permitted, isLab ? ['encounter'] : evidence);
  const b = quality(columnTwo, permitted, evidence);
  // A published lab repeat example permits 59 or 91 when the fictional record indicates a medically necessary repeat.
  const labRepeat = isLab && columnTwo.evidence === 'repeat-lab' && columnTwo.modifiers.includes('59');
  if (a.documented.length || b.documented.length || labRepeat) return 'documented-review';
  if (a.reported.length || b.reported.length) return 'modifier-unverified';
  return 'pair-review';
}

const finding = (kind, level, title, detail, lines, source = null) => ({
  kind, level, title, detail, lineIds: lines.map(line => line.id), source,
});

const serviceKey = line => `${line.entity}/${line.day}`;
const codeKey = line => `${serviceKey(line)}/${line.code}`;

function groupBy(lines, key) {
  const groups = new Map();
  for (const line of lines) {
    const value = key(line);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(line);
  }
  return groups;
}

function repeatedLines(lines) {
  const results = [];
  const candidates = lines.filter(line => {
    const repeat = [...DISTINCT_MODIFIERS, '76', '77'].filter(modifier => modifier !== '91' || !Object.keys(CATALOG[line.code].rows).length);
    return !quality(line, repeat).documented.length;
  });
  for (const group of groupBy(candidates, line => `${codeKey(line)}/${line.units}/${[...line.modifiers].sort().join(',')}`).values()) {
    if (group.length < 2) continue;
    const tariffs = [...groupBy(group, line => line.billed).entries()].sort(([a], [b]) => a - b);
    for (const [amount, exact] of tariffs) {
      if (exact.length > 1) results.push(finding('exact-duplicate', 'review', 'Repeated charge',
        `${exact.length} identical ${group[0].code} charges at ${usd(amount)} on the same date and biller. Ask whether the service was billed more than once.`, exact));
    }
    const nearby = new Set();
    for (let i = 1; i < tariffs.length; i++) {
      const [lower, first] = tariffs[i - 1];
      const [upper, second] = tariffs[i];
      const gap = upper - lower;
      if (gap <= 2500 && gap * 20 <= lower) for (const line of [...first, ...second]) nearby.add(line.id);
    }
    if (nearby.size) results.push(finding('near-duplicate', 'review', 'Similar same-day charges',
      `Same biller, code ${group[0].code}, units and modifiers. Nearby prices differ by at most 5% of the lower charge and $25. Compare what was actually performed.`,
      group.filter(line => nearby.has(line.id))));
  }
  return results;
}

function codingEdits(lines) {
  const results = [];
  const applicable = lines.filter(line => practitioners.includes(line.entity));
  for (const group of groupBy(applicable, serviceKey).values()) {
    for (const [firstCode, secondCode, indicator, context] of PTP) {
      const first = group.filter(line => line.code === firstCode);
      const second = group.filter(line => line.code === secondCode);
      if (!first.length || !second.length) continue;
      for (const line of second) {
        const assessments = first.map(row => assessPair(row, line, indicator, context));
        const status = ['no-exception', 'modifier-unverified', 'pair-review', 'documented-review'].find(key => assessments.includes(key));
        if (!status) continue;
        const description = {
          'no-exception': 'The published indicator does not allow a modifier exception.',
          'modifier-unverified': 'A modifier is present but the fictional documentation does not support the stated distinction.',
          'pair-review': 'No relevant distinct-service modifier is shown. Ask whether the component was already included.',
          'documented-review': 'A modifier and matching fictional documentation are present. Ask the biller to confirm applicability; this is not a payment determination.',
        }[status];
        results.push(finding(`ptp-${status}`, status === 'documented-review' ? 'note' : 'review',
          status === 'documented-review' ? 'Modifier evidence noted' : 'Possible unbundling',
          `${firstCode} is column one and ${secondCode} is column two. ${description}`,
          [...first, line], context === 'laboratory' ? 'ncciLab' : 'ncciSurgery'));
      }
    }
  }
  for (const group of groupBy(applicable, codeKey).values()) {
    const code = group[0].code;
    const edit = CATALOG[code].mue;
    if (!edit) continue;
    const [limit, mai] = edit;
    const scopes = mai === 1 ? group.map(line => [line]) : [group];
    for (const scope of scopes) {
      const units = scope.reduce((sum, row) => sum + row.units, 0);
      if (units <= limit) continue;
      const basis = mai === 1 ? 'per claim line' : mai === 2 ? 'per day, policy-based' : 'per day, clinically based';
      results.push(finding('mue-units', 'review', 'Units above the reference',
        `${code} has ${units} units against ${limit} ${basis} (MAI ${mai}). Ask the biller to explain the units.`, scope, 'mue'));
    }
  }
  return results;
}

function reconcile(lines, totals, selfPay) {
  const charged = lines.reduce((sum, line) => sum + line.billed, 0);
  const { billed, adjustment, allowed, deductible, coinsurance, copay, insurer, patient } = totals;
  const balances = [
    ['line-total', 'Line items vs billed total', charged, billed],
    ['allowed-total', 'Billed less adjustment vs allowed', billed - adjustment, allowed],
    selfPay
      ? ['patient-total', 'Plan payment and cost sharing should be zero for self-pay', insurer + deductible + coinsurance + copay, 0]
      : ['patient-total', 'Deductible + coinsurance + copay vs patient share', deductible + coinsurance + copay, patient],
    ['payer-total', 'Plan payment + patient share vs allowed', insurer + patient, allowed],
  ];
  return balances.map(([key, label, computed, reported]) => ({ key, label, computed, reported, matches: computed === reported }));
}

export function audit(snapshot) {
  validateSnapshot(snapshot);
  const { lines, totals, gfe } = snapshot;
  const balances = reconcile(lines, totals, snapshot.id === 'demo-imaging');
  const findings = [
    ...repeatedLines(lines),
    ...codingEdits(lines),
    ...balances.filter(row => !row.matches).map(row => finding(`math-${row.key}`, 'review', 'Amounts do not reconcile',
      `${row.label}. Calculated ${usd(row.computed)}, reported ${usd(row.reported)}.`, [])),
  ];
  let estimate = null;
  if (gfe) {
    const scope = lines.filter(line => line.entity === gfe.entity);
    const days = [...new Set(scope.map(line => line.day))];
    estimate = !scope.length || days.length !== 1 ? { state: 'unavailable' } : compareEstimate({
      ...gfe, billed: scope.reduce((sum, line) => sum + line.billed, 0), serviceDay: days[0],
    });
    if (estimate.state === 'potential-ppdr') findings.push(finding('gfe-threshold', 'review', 'Above the self-pay estimate',
      `The same biller charged ${usd(estimate.gap)} above the written estimate. That meets the $400 amount screen. The initial bill was ${estimate.elapsed} days old on the fictional check date. Verify the other CMS requirements.`,
      scope, 'ppdr'));
    if (estimate.state === 'outside-window' || (estimate.state === 'missing-prerequisites' && estimate.meetsAmount)) {
      findings.push(finding('gfe-context', 'note', 'Verify dispute timing and prerequisites',
        `The same-biller gap is ${usd(estimate.gap)}. The deadline or a prerequisite was not met in this check. Ask the biller about correction options.`,
        scope, 'ppdr'));
    }
  }
  return {
    ruleVersion: RULESET,
    reviewCount: findings.filter(row => row.level === 'review').length,
    findings,
    balances,
    estimate,
    references: lines.map(line => ({ id: line.id, ...lineReference(line, snapshot.locality) })),
  };
}
