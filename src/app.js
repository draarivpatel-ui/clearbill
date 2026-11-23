import { CASES, CATALOG, DISTINCT_MODIFIERS, ENTITY, EVIDENCE, LOCALITIES, SOURCES } from './data.js';
import { audit, calculateReference, parseDollars, screenFpl, usd } from './engine.js';
import { canonical, makeBundle, makeCsv, MAX_BUNDLE_BYTES, openSummary, sealSummary, verifyBundle } from './exchange.js';
import { createCase } from './fixtures.js';
import { COPY, worksheetTopics } from './worksheet.js';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const state = { view: 'audit', language: 'en', snapshot: createCase('demo-er'), report: null, fragment: null, build: 0 };
const lab = { api: null, decode: null };
const reasoning = { api: null };
const codeOrder = [
  '99281', '99282', '99283', '99284', '99285', '99213', '71046', '70551', '72148', '74177', '80053', '80048',
  '80061', '82465', '84478', '83718', '82947', '85025', '36415', '45385', '45380', 'G0514', 'G2211',
];
const labels = {
  none: 'No documentation shown', encounter: 'Separate encounter', site: 'Separate site or structure',
  practitioner: 'Separate practitioner', nonoverlap: 'Distinct, nonoverlapping service',
  'repeat-lab': 'Medically necessary repeat laboratory test',
};
const billingFields = [
  ['billed', 'Billed charges'], ['adjustment', 'Contract adjustment'], ['allowed', 'Allowed by this plan or biller'],
  ['insurer', 'Plan paid'], ['deductible', 'Deductible'], ['coinsurance', 'Coinsurance'], ['copay', 'Copay'], ['patient', 'Patient responsibility'],
];
const findingTags = {
  'exact-duplicate': 'Duplicate', 'near-duplicate': 'Similarity', 'ptp-pair-review': 'Coding pair',
  'ptp-no-exception': 'Coding pair', 'ptp-modifier-unverified': 'Modifier check', 'ptp-documented-review': 'Documentation',
  'mue-units': 'Unit limit', 'gfe-threshold': 'Estimate', 'gfe-context': 'Dispute context',
};

function node(tag, text = '', className = '') {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function option(value, text) {
  const el = node('option', text);
  el.value = value;
  return el;
}

function link(key, text) {
  const el = node('a', text);
  el.href = SOURCES[key];
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  return el;
}

function cell(row, label, content, cls) {
  const td = node('td', '', cls);
  td.setAttribute('role', 'cell');
  td.dataset.label = label;
  td.append(content);
  row.append(td);
  return td;
}

function announce(text) { $('announcer').textContent = text; }

const titleFor = view => (view === 'audit' ? 'case-title' : `${view}-title`);

function showView(view, focus = true) {
  state.view = view;
  document.body.dataset.print = view === 'worksheet' ? 'worksheet' : '';
  for (const button of all('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  for (const panel of all('[data-panel]')) panel.hidden = panel.dataset.panel !== view;
  if (view === 'worksheet') renderWorksheet();
  if (view === 'reference') renderReference();
  if (view === 'reasoning') reasoning.api?.update(state.snapshot);
  if (focus) $(titleFor(view)).focus();
}

function selectCase(id, locality, follow = true) {
  state.snapshot = createCase(id, locality);
  $('locality').value = state.snapshot.locality;
  const priced = state.snapshot.lines.find(row => row.entity !== 'demo-hospital' && Object.keys(CATALOG[row.code].rows).length);
  $('ref-code').value = priced.code;
  $('ref-setting').value = priced.setting;
  $('ref-component').value = priced.modifiers.find(modifier => modifier === '26' || modifier === 'TC') || 'base';
  updateEditLines();
  $('edit-status').textContent = '';
  render();
  if (follow) showView('audit');
}

function render() {
  state.build++;
  const { snapshot } = state;
  const info = CASES[snapshot.id];
  state.report = audit(snapshot);
  for (const button of all('[data-case]')) button.setAttribute('aria-pressed', String(button.dataset.case === snapshot.id));
  $('case-title').textContent = info.name;
  $('case-meta').replaceChildren(...[info.setting, info.coverage, LOCALITIES[snapshot.locality].name].map(value => node('span', value)));
  $('bill-id').textContent = `${snapshot.id.toUpperCase()} / ${snapshot.lines[0].day}`;
  $('share-output').hidden = true;
  $('share-link').value = '';
  $('share-key').value = '';
  $('export-status').textContent = '';
  const lines = new Set(state.report.findings.flatMap(row => row.level === 'review' ? row.lineIds : []));
  const table = node('table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Itemized bill and illustrative Medicare references');
  const tableFields = ['Service and biller', 'Units', 'Charged', 'PFS ref.'];
  const headRow = table.createTHead().insertRow();
  headRow.parentElement.setAttribute('role', 'rowgroup');
  headRow.setAttribute('role', 'row');
  tableFields.forEach(text => {
    const head = node('th', text);
    head.setAttribute('role', 'columnheader');
    head.scope = 'col';
    headRow.append(head);
  });
  const body = table.createTBody();
  body.setAttribute('role', 'rowgroup');
  snapshot.lines.forEach((line, i) => {
    const row = body.insertRow();
    row.setAttribute('role', 'row');
    row.id = `bill-${line.id}`;
    row.tabIndex = -1;
    row.classList.toggle('line-highlight', lines.has(line.id));
    const desc = node('div', '', 'line-description');
    desc.append(node('strong', CATALOG[line.code].name), node('small', `${line.id.replace('line-', 'L')} / ${line.code}${line.modifiers.length ? `-${line.modifiers.join('-')}` : ''} / ${ENTITY[line.entity]}`, 'code'));
    const ref = state.report.references[i];
    cell(row, tableFields[0], desc);
    cell(row, tableFields[1], String(line.units), 'money');
    cell(row, tableFields[2], usd(line.billed), 'money');
    const rate = cell(row, tableFields[3], ref.lineCents === null ? 'N/A' : `${usd(ref.lineCents)}${ref.comparisonOnly ? '*' : ''}`,
      ref.lineCents === null ? 'money rate-unavailable' : 'money');
    if (ref.comparisonOnly) rate.title = 'Professional illustration only, not a hospital facility fee';
  });
  const wrapper = node('div', '', 'table-wrap');
  wrapper.append(table);
  $('ledger').replaceChildren(wrapper, node('p', '* Medicare clinician-rate illustration, not a hospital facility fee, private plan allowance or savings estimate. N/A means this schedule does not price that line here.', 'ledger-note'));
  renderTotals(snapshot);
  renderFindings();
  if (state.view === 'worksheet') renderWorksheet();
  if (state.view === 'reference') renderReference();
}

function renderTotals(snapshot) {
  const selfPay = snapshot.id === 'demo-imaging';
  const fields = selfPay ? [['billed', 'Billed charges'], ['adjustment', 'Self-pay adjustment'], ['patient', 'Patient responsibility']] : billingFields;
  const balanceRows = fields.map(([key, name]) => {
    const row = node('div', '', key === 'patient' ? 'balance-row balance-final' : 'balance-row');
    row.append(node('dt', name), node('dd', usd(snapshot.totals[key]), 'money'));
    return row;
  });
  const dl = node('dl', '', 'balances');
  dl.append(...balanceRows);
  const heading = node('h3', selfPay ? 'Bill summary' : 'Explanation of benefits');
  const matched = state.report.balances.filter(row => row.matches).length;
  $('settlement').replaceChildren(heading, dl, node('p', `${matched} of 4 balance checks match.`, 'ledger-note'));
  if (state.report.estimate) {
    const { gap, threshold, state: result, elapsed } = state.report.estimate;
    const note = Number.isInteger(gap) ? `Written estimate ${usd(snapshot.gfe.estimated)}. Same-biller difference ${usd(gap)}. Amount screen ${usd(threshold)}${elapsed === null ? '' : `, initial bill ${elapsed} days old at check`}.` : 'There is no single matching estimate and service date for this biller.';
    const metadata = node('p', note, 'ledger-note');
    metadata.dataset.estimate = result;
    $('settlement').append(metadata);
  }
}

function focusLine(id) { $(`bill-${id}`)?.focus(); }

function renderFindings() {
  const { findings, reviewCount } = state.report;
  $('finding-count').textContent = String(reviewCount);
  $('finding-count').setAttribute('aria-label', `${reviewCount} items to review`);
  $('finding-count').dataset.empty = String(reviewCount === 0);
  $('review-jump').textContent = `Go to audit findings (${reviewCount} ${reviewCount === 1 ? 'flag' : 'flags'})`;
  if (!findings.length) {
    const clean = node('div', '', 'clean-state');
    clean.append(node('h3', 'No flags in this example'), node('p', 'The four balance checks match, and the selected coding and duplicate checks found nothing to review. This is not proof that a bill is correct.'));
    $('findings').replaceChildren(clean);
    return;
  }
  const list = node('ol', '', 'finding-list');
  list.setAttribute('role', 'list');
  findings.forEach((item, index) => {
    const li = node('li', '', 'finding');
    li.dataset.kind = item.kind;
    li.dataset.level = item.level;
    const mark = node('span', String(index + 1).padStart(2, '0'), 'finding-index');
    mark.setAttribute('aria-hidden', 'true');
    const body = node('div', '', 'finding-body');
    const tag = findingTags[item.kind] || 'Balance check';
    body.append(node('h3', item.title), node('span', tag, 'finding-tag'), node('p', item.detail));
    const refs = node('div', '', 'finding-refs');
    for (const id of item.lineIds) {
      const button = node('button', id.replace('line-', 'L'));
      button.type = 'button';
      button.setAttribute('aria-label', `Go to bill ${id.replace('-', ' ')}`);
      button.addEventListener('click', () => focusLine(id));
      refs.append(button);
    }
    if (item.source) refs.append(link(item.source, 'CMS source'));
    if (refs.childElementCount) body.append(refs);
    li.append(mark, body);
    list.append(li);
  });
  $('findings').replaceChildren(list);
}

function renderReference() {
  const place = LOCALITIES[state.snapshot.locality];
  const result = calculateReference($('ref-code').value, state.snapshot.locality, $('ref-setting').value, $('ref-component').value);
  const reference = $('reference-result');
  if (!result.available) {
    reference.replaceChildren(node('h2', 'No reference for this selection'),
      node('p', result.reason === 'not-listed'
        ? 'This release has no separately priced row for the selected code and component in this catalog. Many lab services are priced under a different schedule.'
        : 'CMS marks this setting as not applicable for this component. Select an applicable setting or component.'));
    return;
  }
  const metric = node('p', usd(result.cents), 'reference-value');
  const table = node('table', '', 'formula-table');
  table.setAttribute('aria-label', 'Geographically adjusted relative value components');
  const thead = table.createTHead().insertRow();
  for (const label of ['Component', 'RVU', 'GPCI', 'Product']) {
    const th = node('th', label);
    th.scope = 'col';
    thead.append(th);
  }
  const rows = table.createTBody();
  ['Work', 'Practice expense', 'Malpractice'].forEach((label, i) => {
    const row = rows.insertRow();
    for (const part of [label, (result.rvu[i] / 100).toFixed(2), (result.gpci[i] / 1000).toFixed(3), (result.products[i] / 100000).toFixed(5)]) row.append(node('td', part));
  });
  reference.replaceChildren(node('h2', 'Illustrative amount per unit'), metric, node('p', `${place.name} / MAC and locality ${place.mac}`), table,
    node('p', `Sum of product rows multiplied by $${(result.conversion / 10000).toFixed(4)}, then rounded once to cents. October 2026 CMS RVU26D, non-QP conversion factor.`));
}

function renderFpl() {
  const host = $('fpl-result');
  try {
    const income = parseDollars($('fpl-income').value);
    const value = $('fpl-size').valueAsNumber;
    const result = screenFpl($('fpl-region').value, value, income);
    const hint = result.band === 'at-or-below-200' ? 'At or below the example 200% threshold.'
      : result.band === 'at-or-below-400' ? 'Between the example 200% and 400% thresholds.' : 'Above the example 400% threshold.';
    host.replaceChildren(node('p', `${(result.percentTenths / 10).toFixed(1)}% of FPL`, 'reference-value'),
      node('p', `2026 guideline ${usd(result.guideline)} for this household. ${hint} Ask the hospital about its own criteria.`));
  } catch {
    host.replaceChildren(node('p', 'Enter a household size of 1 to 50 and a fictional annual income up to $1,000,000, without commas.'));
  }
}

function renderWorksheet() {
  const { snapshot, report, language } = state;
  const words = COPY[language];
  const meta = node('p', `${words.practice} / ${words.cases[snapshot.id]}`, 'worksheet-meta');
  const summary = node('dl', '', 'worksheet-summary');
  for (const [name, value] of [[words.billed, snapshot.totals.billed], [words.patient, snapshot.totals.patient]]) {
    const entry = node('div');
    entry.append(node('dt', name), node('dd', usd(value)));
    summary.append(entry);
  }
  const questions = node('ol', '', 'worksheet-list');
  for (const topic of worksheetTopics(report)) questions.append(node('li', words.checks[topic]));
  const notes = node('div', '', 'worksheet-note');
  notes.append(node('h2', words.notes), node('p', words.reminders));
  for (let i = 0; i < 3; i++) {
    const line = node('div', '', 'write-line');
    line.setAttribute('aria-hidden', 'true');
    notes.append(line);
  }
  $('worksheet-paper').lang = language;
  $('worksheet-title').textContent = words.title;
  $('worksheet-body').replaceChildren(meta, summary, node('h2', words.prepare), node('p', words.documents),
    node('h2', words.questions), questions, ...(snapshot.gfe ? [node('p', words.time)] : []), notes, node('p', words.footer, 'worksheet-footer'));
  for (const button of all('[data-language]')) button.setAttribute('aria-pressed', String(button.dataset.language === language));
}

function updateEditLines() {
  const select = $('edit-line');
  select.replaceChildren(...state.snapshot.lines.map(line => option(line.id, `${line.id.replace('line-', 'L')} / ${CATALOG[line.code].name} / ${ENTITY[line.entity]}`)));
  fillEditLine();
}

function fillEditLine() {
  const line = state.snapshot.lines.find(row => row.id === $('edit-line').value);
  $('edit-units').value = line.units;
  $('edit-charge').value = (line.billed / 100).toFixed(2);
  $('edit-modifier').value = line.modifiers.find(mod => DISTINCT_MODIFIERS.includes(mod)) || '';
  $('edit-evidence').value = line.evidence;
}

function editLine(event) {
  event.preventDefault();
  const original = state.snapshot.lines.find(row => row.id === $('edit-line').value);
  const modifier = $('edit-modifier').value;
  const candidate = {
    ...original, units: $('edit-units').valueAsNumber, billed: parseDollars($('edit-charge').value),
    modifiers: [...original.modifiers.filter(value => !DISTINCT_MODIFIERS.includes(value)), ...(modifier ? [modifier] : [])],
    evidence: $('edit-evidence').value,
  };
  const proposed = { ...state.snapshot, lines: state.snapshot.lines.map(row => row === original ? candidate : row) };
  try {
    audit(proposed);
    state.snapshot = proposed;
    render();
    $('edit-status').textContent = `Fictional ${original.id} updated. Reported totals were kept for reconciliation.`;
    announce(`${state.report.reviewCount} items to review.`);
  } catch {
    $('edit-status').textContent = 'Enter valid units and an amount in dollars with up to two decimal places, without commas.';
  }
}

function canCrypto() { return window.isSecureContext && Boolean(globalThis.crypto?.subtle); }

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = node('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

function exportMessage(message) { $('export-status').textContent = message; }

async function exportJson() {
  if (!canCrypto()) return exportMessage('Bundle hashing needs HTTPS or localhost.');
  const sample = state.snapshot;
  try {
    download(`clearbill-${sample.id}.json`, `${canonical(await makeBundle(sample))}\n`, 'application/json');
    exportMessage('Audit JSON downloaded. The digest checks integrity, not who created the file.');
  } catch { exportMessage('Could not build a bundle. Try again in a secure browser.'); }
}

async function checkFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!canCrypto()) return exportMessage('Bundle replay needs HTTPS or localhost.');
  if (file.size > MAX_BUNDLE_BYTES) return exportMessage('Choose a fictional audit JSON file under 128 KiB.');
  try {
    const result = await verifyBundle(await file.text());
    exportMessage(result.ok ? `Replay matched. SHA-256 verified. ${result.reviewCount} items to review.` : result.reason);
  } catch { exportMessage('The file could not be read.'); }
}

async function makeShare() {
  if (!canCrypto()) return exportMessage('Sealing needs HTTPS or localhost.');
  const { snapshot, build } = state;
  try {
    const { fragment, key } = await sealSummary(snapshot.id, snapshot.locality);
    if (build !== state.build) return;
    const share = new URL('./', location.href);
    share.hash = fragment;
    $('share-link').value = share.href;
    $('share-key').value = key;
    $('share-output').hidden = false;
    $('share-link').select();
    exportMessage('Link sealed. Share the random key separately. Custom line edits stay out of the summary.');
  } catch { exportMessage('Could not seal a summary.'); }
}

function closeShare() {
  state.fragment = null;
  $('share-open-panel').hidden = true;
  $('open-key').value = '';
}

function acceptSealedLink() {
  if (!location.hash.startsWith('#sealed=')) return false;
  state.fragment = location.hash.length <= 520 ? location.hash : '#sealed=invalid';
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  $('share-open-status').textContent = '';
  $('open-key').value = '';
  $('share-open-panel').hidden = false;
  return true;
}

async function receiveShare(event) {
  event.preventDefault();
  if (!canCrypto()) {
    $('share-open-status').textContent = 'Opening a summary needs HTTPS or localhost.';
    return;
  }
  const fragment = state.fragment;
  try {
    const { id, locality } = await openSummary(fragment, $('open-key').value.trim());
    if (state.fragment !== fragment) return;
    closeShare();
    selectCase(id, locality);
    announce('Fictional summary opened.');
  } catch (error) { if (state.fragment === fragment) $('share-open-status').textContent = error.message; }
}

function initialize() {
  $('case-list').replaceChildren(...Object.entries(CASES).map(([id, info], index) => {
    const button = node('button', '', 'case-button');
    button.type = 'button';
    button.dataset.case = id;
    const number = node('span', String(index + 1).padStart(2, '0'), 'case-index');
    number.setAttribute('aria-hidden', 'true');
    const label = node('span');
    label.append(node('strong', info.name, 'case-name'), node('span', info.detail, 'case-detail'));
    button.append(number, label);
    button.addEventListener('click', () => selectCase(id));
    return button;
  }));
  $('locality').replaceChildren(...Object.entries(LOCALITIES).map(([key, value]) => option(key, value.name)));
  $('ref-code').replaceChildren(...codeOrder.map(code => option(code, `${code} / ${CATALOG[code].name}`)));
  $('edit-modifier').replaceChildren(option('', 'None'), ...DISTINCT_MODIFIERS.map(mod => option(mod, mod)));
  $('edit-evidence').replaceChildren(...EVIDENCE.map(key => option(key, labels[key])));
  const sources = node('ul');
  for (const [key, name] of [
    ['mpfs', 'CMS October 2026 relative value files'], ['ptp', 'CMS NCCI PTP edits overview'], ['ncciLab', 'CMS NCCI laboratory policy examples'],
    ['ncciSurgery', 'CMS surgical modifier example'], ['modifiers', 'CMS NCCI modifier guidance'], ['mue', 'CMS Medicare practitioner MUE tables'],
    ['ppdr', 'CMS self-pay dispute guidance'], ['fpl', '2026 HHS poverty guidelines'], ['irs', 'IRS financial assistance policy'],
  ]) {
    const li = node('li'); li.append(link(key, name)); sources.append(li);
  }
  $('sources').replaceChildren(sources);
  for (const button of all('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
  $('worksheet-open').addEventListener('click', () => showView('worksheet'));
  $('review-jump').addEventListener('click', () => $('findings-heading').focus());
  for (const button of all('[data-language]')) button.addEventListener('click', () => {
    state.language = button.dataset.language;
    renderWorksheet();
  });
  $('print-sheet').addEventListener('click', () => window.print());
  $('locality').addEventListener('change', () => {
    state.snapshot = { ...state.snapshot, locality: $('locality').value };
    render();
  });
  for (const id of ['ref-code', 'ref-setting', 'ref-component']) $(id).addEventListener('change', renderReference);
  for (const id of ['fpl-region', 'fpl-size', 'fpl-income']) $(id).addEventListener('input', renderFpl);
  for (const id of ['reference-controls', 'fpl-form']) $(id).addEventListener('submit', event => event.preventDefault());
  $('edit-line').addEventListener('change', fillEditLine);
  $('edit-form').addEventListener('submit', editLine);
  $('edit-reset').addEventListener('click', () => {
    selectCase(state.snapshot.id, state.snapshot.locality, false);
    $('edit-status').textContent = 'Restored the original fictional charges.';
  });
  $('export-csv').addEventListener('click', () => {
    download(`clearbill-${state.snapshot.id}.csv`, makeCsv(state.snapshot), 'text/csv;charset=utf-8');
    exportMessage('Fictional audit ledger downloaded.');
  });
  $('export-json').addEventListener('click', exportJson);
  $('replay-file').addEventListener('change', checkFile);
  $('share-seal').addEventListener('click', makeShare);
  $('share-open-form').addEventListener('submit', receiveShare);
  $('discard-share').addEventListener('click', () => { closeShare(); $(titleFor(state.view)).focus(); });
  selectCase('demo-er', undefined, false);
  renderFpl();
  acceptSealedLink();
  import('./sensitivity-lab.js').then(module => {
    lab.api = module.mountSensitivityLab($('lab-panel'));
    lab.decode = module.decodeLabHash;
    if (location.hash.startsWith('#cbl=')) {
      if (lab.api.applyState(lab.decode(location.hash))) showView('lab', false);
    }
  }).catch(() => {
    lab.api = null;
    lab.decode = null;
    for (const button of all('[data-view=lab]')) button.remove();
    $('lab-panel')?.remove();
  });
  import('./ai-appeal-reasoning.js').then(module => {
    reasoning.api = module.mountReasoningLab($('reasoning-panel'));
  }).catch(() => {
    reasoning.api = null;
    for (const button of all('[data-view=reasoning]')) button.remove();
    $('reasoning-panel')?.remove();
  });
  window.addEventListener('hashchange', () => {
    if (acceptSealedLink()) {
      $('open-key').focus();
      return;
    }
    if (lab.api && location.hash.startsWith('#cbl=')) {
      if (lab.api.applyState(lab.decode(location.hash))) showView('lab', false);
    }
  });
}

async function offlineReady() {
  const label = $('offline-status');
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    label.textContent = 'Offline setup needs HTTPS or localhost';
    return;
  }
  try {
    const worker = navigator.serviceWorker;
    await worker.register('./sw.js', { scope: './' });
    const registration = await worker.ready;
    if (registration.scope !== new URL('./', location.href).href) throw new Error('Unexpected service worker scope.');
    const update = () => {
      if (!worker.controller) return;
      label.textContent = 'Offline ready';
      label.dataset.ready = 'true';
    };
    worker.addEventListener('controllerchange', update);
    update();
  } catch { label.textContent = 'Offline setup could not finish'; }
}

initialize();
void offlineReady();
