import { CASES, CATALOG, ENTITY, LOCALITIES, RULESET } from './data.js';
import { audit, validateSnapshot, validSelection } from './engine.js';

export const MAX_BUNDLE_BYTES = 128 * 1024;
const BUNDLE = 'clearbill-audit-v1';
const SEALED = 'clearbill-summary-v1';
const text = new TextEncoder();
const readText = new TextDecoder('utf-8', { fatal: true });
const ownKeys = (a, expected) => a !== null && typeof a === 'object' && !Array.isArray(a)
  && Object.keys(a).length === expected.length && expected.every(k => Object.hasOwn(a, k));

// ClearBill canonical form: sorted object keys, original array order and JSON scalars.
export function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${[...value].map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Canonical form supports plain JSON records with safe integers only.');
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', text.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function makeBundle(snapshot) {
  const input = structuredClone(validateSnapshot(snapshot));
  const payload = { schema: BUNDLE, input, report: audit(input) };
  return { payload, sha256: await sha256(canonical(payload)) };
}

export async function verifyBundle(value) {
  if (typeof value !== 'string' || value.length > MAX_BUNDLE_BYTES || text.encode(value).length > MAX_BUNDLE_BYTES) {
    return { ok: false, reason: 'Bundle exceeds the 128 KiB limit or is not text.' };
  }
  try {
    const doc = JSON.parse(value);
    if (!ownKeys(doc, ['payload', 'sha256']) || typeof doc.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(doc.sha256)
      || !ownKeys(doc.payload, ['schema', 'input', 'report']) || doc.payload.schema !== BUNDLE
      || doc.payload.report?.ruleVersion !== RULESET) {
      return { ok: false, reason: 'Unknown or incomplete bundle format or rule version.' };
    }
    validateSnapshot(doc.payload.input);
    const actualReport = audit(doc.payload.input);
    if (canonical(actualReport) !== canonical(doc.payload.report)) return { ok: false, reason: 'Report differs from deterministic replay.' };
    if (await sha256(canonical(doc.payload)) !== doc.sha256) return { ok: false, reason: 'SHA-256 digest mismatch.' };
    return { ok: true, sha256: doc.sha256, reviewCount: actualReport.reviewCount, caseId: doc.payload.input.id };
  } catch {
    return { ok: false, reason: 'Invalid bundle. Choose a ClearBill fictional audit JSON file.' };
  }
}

export function csvCell(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  let content = String(value ?? '');
  // Quote fields and neutralize formula prefixes, including those after whitespace or controls.
  if (/^[\u0000-\u0020\u007f\u00a0\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20]|^[\t\r\n]/u.test(content)) content = `'${content}`;
  return `"${content.replaceAll('"', '""')}"`;
}

export function makeCsv(snapshot) {
  const { references, findings, balances, estimate } = audit(snapshot);
  const rows = [
    ['record_type', 'ruleset', 'fictional_case', 'locality', 'record_id', 'service_date', 'biller', 'setting', 'code', 'description',
      'modifiers', 'units', 'billed_cents', 'reference_per_unit_cents', 'reference_line_cents', 'reference_scope',
      'finding_codes', 'computed_cents', 'reported_cents', 'result'],
    ...snapshot.lines.map((line, i) => [
      'line', RULESET, CASES[snapshot.id].name, LOCALITIES[snapshot.locality].name, line.id, line.day, ENTITY[line.entity], line.setting, line.code,
      CATALOG[line.code].name, line.modifiers.join(' '), line.units, line.billed, references[i].unitCents,
      references[i].lineCents, references[i].comparisonOnly ? 'Professional illustration only; not a facility fee' : references[i].reason || 'Professional reference',
      findings.filter(row => row.lineIds.includes(line.id)).map(row => row.kind).join(' '), '', '', '',
    ]),
    ...findings.map((row, i) => ['finding', RULESET, '', '', i + 1, '', '', '', '', row.detail, '', '', '', '', '', '', row.kind, '', '', row.level]),
    ...balances.map(row => ['balance', RULESET, '', '', row.key, '', '', '', '', row.label, '', '', '', '', '', '', '', row.computed, row.reported, row.matches ? 'matches' : 'mismatch']),
  ];
  if (estimate) rows.push(['estimate', RULESET, '', '', snapshot.gfe.entity, '', '', '', '', 'Good faith estimate gap', '', '', '', '', '', '', '', estimate.gap, estimate.threshold, estimate.state]);
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value, max) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid share token.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new TypeError('Invalid share token.');
  return bytes;
}

const spec = iv => ({ name: 'AES-GCM', iv, additionalData: text.encode(SEALED), tagLength: 128 });

export async function sealSummary(id, locality) {
  if (!validSelection(id, locality)) throw new TypeError('Only fictional preset and locality IDs can be sealed.');
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const data = text.encode(canonical({ schema: SEALED, ruleVersion: RULESET, id, locality }));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(spec(iv), key, data));
  return { fragment: `#sealed=v1.${encode(iv)}.${encode(cipher)}`, key: encode(keyBytes) };
}

export async function openSummary(fragment, keyToken) {
  try {
    if (typeof fragment !== 'string' || fragment.length > 520 || !fragment.startsWith('#sealed=v1.')) throw new Error();
    const parts = fragment.slice('#sealed=v1.'.length).split('.');
    if (parts.length !== 2 || parts[0].length !== 16 || typeof keyToken !== 'string' || keyToken.length !== 43) throw new Error();
    const keyBytes = decode(keyToken, 43);
    const iv = decode(parts[0], 16);
    const cipher = decode(parts[1], 450);
    if (iv.length !== 12 || keyBytes.length !== 32 || cipher.length < 16) throw new Error();
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const decoded = await crypto.subtle.decrypt(spec(iv), key, cipher);
    const data = JSON.parse(readText.decode(decoded));
    if (!ownKeys(data, ['schema', 'ruleVersion', 'id', 'locality']) || data.schema !== SEALED
      || data.ruleVersion !== RULESET || !validSelection(data.id, data.locality)) throw new Error();
    return { id: data.id, locality: data.locality };
  } catch {
    throw new TypeError('Could not open this fictional summary. Check the link, key and rule version.');
  }
}
