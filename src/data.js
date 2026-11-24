export const RULESET = 'clearbill-2026q4-v2';
export const CONVERSION_1E4 = 334009;
export const SERVICE_DATES = Object.freeze(['2026-10-08', '2026-10-21', '2026-11-03']);
export const LOCALITIES = Object.freeze({
  houston: Object.freeze({ name: 'Houston, TX', mac: '04412 / 18', gpci: Object.freeze([1008, 993, 1376]) }),
  manhattan: Object.freeze({ name: 'Manhattan, NY', mac: '13202 / 01', gpci: Object.freeze([1064, 1162, 1586]) }),
  iowa: Object.freeze({ name: 'Iowa statewide', mac: '05102 / 00', gpci: Object.freeze([1000, 915, 397]) }),
});

// RVUs in hundredths, ordered work / office PE / facility PE / malpractice.
// null for an unavailable setting; absent rows are not priced here.
const catalog = {
  99281: ['ER assessment, level 1', { base: [25, null, 5, 3] }, [1, 3]],
  99282: ['ER assessment, level 2', { base: [93, null, 17, 11] }, [1, 3]],
  99283: ['ER assessment, level 3', { base: [160, null, 28, 20] }, [1, 3]],
  99284: ['ER assessment, level 4', { base: [274, null, 45, 35] }, [1, 3]],
  99285: ['ER assessment, level 5', { base: [400, null, 65, 48] }, [1, 3]],
  99213: ['Follow-up office visit', { base: [130, 146, 33, 9] }, [2, 3]],
  71046: ['Chest radiograph, two views', { base: [21, 76, null, 2], 26: [21, 8, 8, 1], TC: [0, 68, null, 1] }, [2, 3]],
  70551: ['Brain MRI without contrast', { base: [144, 431, null, 10], 26: [144, 51, 51, 8], TC: [0, 380, null, 2] }, [2, 3]],
  72148: ['Lower-spine MRI without contrast', { base: [144, 420, null, 10], 26: [144, 53, 53, 8], TC: [0, 367, null, 2] }, [1, 3]],
  74177: ['Abdominal and pelvic CT with contrast', { base: [177, 709, null, 13], 26: [177, 63, 63, 11], TC: [0, 646, null, 2] }, [2, 3]],
  80053: ['Metabolic blood panel', {}, [1, 3]],
  80048: ['Basic metabolic blood panel', {}, [2, 3]],
  80061: ['Blood lipid tests', {}, [1, 3]],
  82465: ['Total cholesterol test', {}, [1, 3]],
  84478: ['Triglyceride test', {}, [1, 3]],
  83718: ['HDL cholesterol test', {}, [1, 3]],
  82947: ['Blood glucose measurement', {}, [5, 3]],
  85025: ['Blood cell count with differential', {}, [2, 3]],
  36415: ['Blood sample collection', {}, [2, 3]],
  45385: ['Colonoscopy with snare removal', { base: [446, 1000, 172, 51] }, [1, 2]],
  45380: ['Colonoscopy with sampling', { base: [347, 1048, 143, 42] }, [1, 2]],
  G0514: ['Extra preventive service time', { base: [117, 70, 28, 7] }, [1, 1]],
  G2211: ['Ongoing complex care add-on', { base: [33, 17, 8, 2] }, null],
};
export const CATALOG = Object.freeze(Object.fromEntries(Object.entries(catalog).map(([code, [name, rows, mue]]) => [
  code, Object.freeze({ name, rows: Object.freeze(Object.fromEntries(Object.entries(rows).map(([key, values]) => [
    key, Object.freeze(values),
  ]))), mue: mue && Object.freeze(mue) }),
])));

export const LAB_TEST_CODES = Object.freeze(['80048', '80053', '80061', '82465', '82947', '83718', '84478', '85025']);
export const EVIDENCE = Object.freeze(['none', 'encounter', 'site', 'practitioner', 'nonoverlap', 'repeat-lab']);
export const DISTINCT_MODIFIERS = Object.freeze(['59', 'XE', 'XS', 'XP', 'XU', '91']);
export const MODIFIERS = Object.freeze(['26', 'TC', ...DISTINCT_MODIFIERS, '76', '77', '25', 'LT', 'RT']);
export const ENTITY = Object.freeze({
  'demo-provider': 'Clinician group',
  'demo-hospital': 'Hospital outpatient',
  'demo-lab': 'Billing laboratory',
  'demo-imaging': 'Imaging center',
});
export const CASES = Object.freeze({
  'demo-er': Object.freeze({ name: 'ER visit', detail: 'Unbundled labs and duplicate charges', setting: 'Emergency care', locality: 'houston', coverage: 'Insured EOB' }),
  'demo-imaging': Object.freeze({ name: 'Outpatient imaging', detail: 'Self-pay bill above its written estimate', setting: 'Scheduled imaging', locality: 'manhattan', coverage: 'Self-pay bill' }),
  'demo-clean': Object.freeze({ name: 'Routine follow-up', detail: 'Clean itemized bill control', setting: 'Office care', locality: 'iowa', coverage: 'Insured EOB' }),
});

export const SOURCES = Object.freeze({
  mpfs: 'https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files/rvu26d',
  ptp: 'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits',
  ncciLab: 'https://www.cms.gov/files/document/10-chapter10-ncci-medicare-policy-manual-2026-final.pdf',
  labComponents: 'https://www.cms.gov/regulations-and-guidance/guidance/transmittals/downloads/r3619cp.pdf',
  ncciSurgery: 'https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=53399',
  modifiers: 'https://www.cms.gov/files/document/01-chapter1-ncci-medicare-policy-manual-2026-final.pdf',
  mue: 'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues',
  ppdr: 'https://www.cms.gov/initiatives/your-patient-rights/medical-bill-rights/get-help/dispute-bill',
  fpl: 'https://www.govinfo.gov/content/pkg/FR-2026-01-15/html/2026-00755.htm',
  irs: 'https://www.irs.gov/charities-non-profits/financial-assistance-policy-and-emergency-medical-care-policy-section-501r4',
});

// Selected relationships documented in the cited CMS policy examples, not a copy of the edit tables.
export const PTP = Object.freeze([
  ['80053', '82947', 1, 'laboratory'],
  ['80061', '82465', 1, 'laboratory'],
  ['80061', '83718', 1, 'laboratory'],
  ['80061', '84478', 1, 'laboratory'],
  ['45385', '45380', 1, 'surgery'],
].map(Object.freeze));
