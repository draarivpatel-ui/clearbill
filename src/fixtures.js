import { CASES, SERVICE_DATES } from './data.js';

function line(number, day, code, entity, setting, billed, modifiers = []) {
  return { id: `line-${number}`, day, code, entity: `demo-${entity}`, setting, units: 1, billed, modifiers, evidence: 'none' };
}

export function createCase(id, locality = Object.hasOwn(CASES, id) ? CASES[id].locality : '') {
  if (!Object.hasOwn(CASES, id)) throw new RangeError('Unknown fictional case.');
  const [erDay, imagingDay, cleanDay] = SERVICE_DATES;
  const cases = {
    'demo-er': {
      lines: [
        line(1, erDay, '99284', 'hospital', 'facility', 148000),
        line(2, erDay, '99284', 'provider', 'facility', 46000),
        line(3, erDay, '80053', 'lab', 'facility', 11800),
        line(4, erDay, '82947', 'lab', 'facility', 3900),
        line(5, erDay, '71046', 'provider', 'facility', 12000, ['26']),
        line(6, erDay, '71046', 'provider', 'facility', 12000, ['26']),
        line(7, erDay, '71046', 'provider', 'facility', 11600, ['26']),
      ],
      totals: { billed: 245300, adjustment: 135300, allowed: 110000, deductible: 20000, coinsurance: 10000, copay: 0, insurer: 80000, patient: 30000 },
      gfe: null,
    },
    'demo-imaging': {
      lines: [line(1, imagingDay, '70551', 'imaging', 'office', 112500)],
      totals: { billed: 112500, adjustment: 0, allowed: 112500, deductible: 0, coinsurance: 0, copay: 0, insurer: 0, patient: 112500 },
      gfe: { entity: 'demo-imaging', estimated: 65000, election: true, estimateBeforeCare: true, initialBill: '2026-10-29', checkedOn: '2026-11-10' },
    },
    'demo-clean': {
      lines: [
        line(1, cleanDay, '99213', 'provider', 'office', 16500),
        line(2, cleanDay, '85025', 'lab', 'office', 3400),
        line(3, cleanDay, '36415', 'lab', 'office', 1100),
      ],
      totals: { billed: 21000, adjustment: 9000, allowed: 12000, deductible: 0, coinsurance: 0, copay: 2500, insurer: 9500, patient: 2500 },
      gfe: null,
    },
  };
  return { id, locality, ...cases[id] };
}
