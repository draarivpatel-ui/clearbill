const en = {
  title: 'Itemized bill worksheet',
  practice: 'Fictional practice copy',
  cases: { 'demo-er': 'ER visit', 'demo-imaging': 'Outpatient imaging', 'demo-clean': 'Routine follow-up' },
  billed: 'Billed charges', patient: 'Patient balance shown', notes: 'Notes and follow-up',
  prepare: 'Before the call',
  documents: 'Gather the itemized bill, explanation of benefits (EOB), receipts and any written good faith estimate. Never send originals or share personal identifiers through ClearBill.',
  questions: 'Questions for the billing office',
  checks: {
    duplicate: 'Which visits or tests do the repeated charges represent? Can you identify the date, service and clinician for each line?',
    ptp: 'Was the test or procedure already included in another line? If billed separately, what documentation supports it?',
    mue: 'How many units were performed? Please explain the number shown on each line.',
    math: 'Please walk through the charges, adjustments, plan payment, deductible, copay and coinsurance. If a total is wrong, can I get a corrected bill?',
    gfe: 'Please compare the initial bill with the written estimate for this same provider. Is a correction possible? Could the federal self-pay dispute process apply?',
    clean: 'Does the itemized bill match my visit and the insurer explanation? Can you confirm the balance in writing?',
    aid: 'What financial assistance is available? Please provide the written policy, eligibility criteria, covered providers and application.',
  },
  time: 'If a same-provider bill is at least $400 above a written estimate for eligible self-pay care, review the CMS requirements. The federal filing window is generally 120 days from the initial bill.',
  reminders: 'Record who responded, what was promised, and when to follow up. Request an updated statement or a written explanation.',
  footer: 'ClearBill  /  Educational checklist, not legal or billing advice.',
};

const es = {
  title: 'Hoja de trabajo para la factura detallada',
  practice: 'Ejemplo ficticio para practicar',
  cases: { 'demo-er': 'Visita a urgencias', 'demo-imaging': 'Estudio de imagen ambulatorio', 'demo-clean': 'Consulta de seguimiento' },
  billed: 'Cargos facturados', patient: 'Saldo indicado para el paciente', notes: 'Notas y seguimiento',
  prepare: 'Antes de llamar',
  documents: 'Re\u00fana la factura detallada, la explicaci\u00f3n de beneficios (EOB), los recibos y cualquier estimaci\u00f3n de buena fe por escrito. No env\u00ede los originales ni comparta datos personales en ClearBill.',
  questions: 'Preguntas para el departamento de facturaci\u00f3n',
  checks: {
    duplicate: '\u00bfA qu\u00e9 visitas o pruebas corresponden los cargos repetidos? \u00bfPueden indicar la fecha, el servicio y el profesional de cada cargo?',
    ptp: '\u00bfLa prueba o el procedimiento ya se incluy\u00f3 en otro cargo? Si se factur\u00f3 por separado, \u00bfqu\u00e9 documentaci\u00f3n lo justifica?',
    mue: '\u00bfCu\u00e1ntas unidades se realizaron? Por favor, expliquen el n\u00famero que aparece en cada cargo.',
    math: '\u00bfPueden explicar los cargos, los ajustes, el pago del seguro, el deducible, el copago y el coseguro? Si un total est\u00e1 mal, \u00bfpueden corregir la factura?',
    gfe: '\u00bfPueden comparar la factura inicial con la estimaci\u00f3n escrita de este mismo proveedor? \u00bfSe puede corregir? \u00bfAplica el proceso federal de disputa para pacientes que pagan por su cuenta?',
    clean: '\u00bfCoinciden la factura detallada, los servicios recibidos y la explicaci\u00f3n del seguro? \u00bfPueden confirmar el saldo por escrito?',
    aid: '\u00bfQu\u00e9 ayuda econ\u00f3mica ofrecen? \u00bfPueden enviarme la pol\u00edtica escrita, los requisitos, la lista de proveedores cubiertos y la solicitud?',
  },
  time: 'Si la factura del mismo proveedor supera en al menos $400 la estimaci\u00f3n escrita para atenci\u00f3n elegible pagada por su cuenta, consulte los requisitos de CMS. El plazo federal suele ser de 120 d\u00edas desde la factura inicial.',
  reminders: 'Anote qui\u00e9n respondi\u00f3, qu\u00e9 prometi\u00f3 y cu\u00e1ndo debe hacer el seguimiento. Solicite una factura actualizada o una explicaci\u00f3n por escrito.',
  footer: 'ClearBill  /  Material educativo, no asesor\u00eda legal ni de facturaci\u00f3n.',
};

export const COPY = Object.freeze({ en, es });

export function worksheetTopics(report) {
  const kinds = report.findings.map(item => item.kind);
  const topics = [
    [kinds.some(kind => kind.endsWith('-duplicate')), 'duplicate'],
    [kinds.some(kind => kind.startsWith('ptp-')), 'ptp'],
    [kinds.includes('mue-units'), 'mue'],
    [kinds.some(kind => kind.startsWith('math-')), 'math'],
    [report.estimate !== null, 'gfe'],
  ].filter(([shown]) => shown).map(([, key]) => key);
  return [...(topics.length ? topics : ['clean']), 'aid'];
}
