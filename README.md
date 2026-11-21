# ClearBill

ClearBill is a browser workbench for learning to read an itemized medical bill. Trace a review flag to the lines that raised it, distinguish a Medicare physician reference from a bill, and print a question checklist in English or Spanish. All patient, biller and episode data are invented.

**Never enter or import real health information, SSNs, bills or account numbers.** This is not a bill adjudicator or medical, billing or legal advice.

## Run

Requires Node.js 22 or newer. No package installation or backend is needed.

```sh
npm start
```

Open `http://127.0.0.1:4173/clearbill/`. The included server only serves the static workbench. For deployment, put the public files at `/clearbill/` over HTTPS and serve the headers in `_headers` or their equivalent. The HTML contains a restrictive fallback policy; deliver `frame-ancestors` by HTTP header because meta tags cannot enforce it. Publish only `index.html`, `styles.css`, `favicon.svg`, `sw.js` and `src/` as public assets. The service worker only handles its own shell and assets on the `/clearbill/` origin and path. Wait for **Offline ready** after the first online load. Bump the service worker cache name for subsequent shell changes.

## Try a bill

| Fictional case | Expected review flags | Reason |
| --- | ---: | --- |
| ER visit | 4 | Exact repeats, near repeats, a panel and component billed together, and imaging units over the selected reference |
| Outpatient imaging | 1 | Same-biller self-pay charges of `$1,125` against a `$650` written good faith estimate, a `$475` difference |
| Routine follow-up | 0 | Negative control with four matching total checks |

- In **Audit**, open a finding's line markers to trace the evidence. Open **Adjust fictional line items** to try bounded edits without changing the printed EOB totals. The difference tests reconciliation. The reference comparison by itself never creates a flag.
- In **Reference**, select a locality, code, service setting and imaging component. Each price shows its work, practice expense and malpractice inputs. The same view has a fictional household guideline screener.
- In **Worksheet**, switch English or Spanish and print. The original patient responsibility is shown as reported, not as a recommended amount to pay.
- In **Export and verify evidence**, save the CSV or canonical audit JSON. Use the verifier in the same browser, or run `npm run verify -- path/to/audit.json`. A digest verifies matching bytes and replay; it is not a signature or proof of origin.

## Method and sources

| Check | Inputs and decision |
| --- | --- |
| Medicare physician formula | The CMS [October 2026 RVU26D file](https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files/rvu26d), `PPRRVU2026_Oct_nonQPP.csv` and `GPCI2026.csv`. Sum `(work RVU × work GPCI) + (PE RVU × PE GPCI) + (malpractice RVU × malpractice GPCI)` and multiply by the non-QP factor `$33.4009`. Exact scaled integers, round half up once per unit, then multiply by units. Localities are Houston 04412/18, Manhattan 13202/01 and Iowa 05102/00. Rows marked NA or without a separately priced PFS row show N/A, not `$0`. This is not OPPS, a hospital facility charge benchmark, a CLFS lab price, private plan allowance, modifier-adjusted final payment or savings estimate. A hospital bill line may show the clinician rate with an asterisk solely as a comparison of unlike amounts. |
| NCCI procedure pairs | Selected practitioner relationships from the [2026 laboratory chapter, section C](https://www.cms.gov/files/document/10-chapter10-ncci-medicare-policy-manual-2026-final.pdf), [CMS chemistry panel membership](https://www.cms.gov/regulations-and-guidance/guidance/transmittals/downloads/r3619cp.pdf) and [CMS's specific colonoscopy modifier example](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=53399). The metabolic panel plus glucose pair is derived from the official panel membership and the chapter's component pairing rule. Same biller and day only; no institutional edit table. Indicator 1 recognizes supported 59/XE/XS/XP/XU evidence in the selected contexts and 91 or 59 for a necessary repeated component test. The result remains a documentation note, not approval. See [CMS modifier guidance](https://www.cms.gov/files/document/01-chapter1-ncci-medicare-policy-manual-2026-final.pdf) for broader policy. |
| MUE | Selected Q4 practitioner `MCR_MUE_PractitionerServices_Eff_10-01-2026.csv` values from [CMS](https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues). MAI 1 checks each line; MAI 2 and 3 total units per same biller, day and code, with different evidence implications. Values not published or not in this catalog are not inferred. |
| Repeats and arithmetic | Repeat candidates match biller, date, code, units and modifiers. Exact candidates have equal line charges; near candidates differ by at most 5% of the lower charge and `$25`. Matching fictional evidence can suppress a repeat candidate, not a daily unit limit. Four integer-cent checks reconcile billed, adjusted, plan paid and patient amounts. The self-pay model checks a zero insurance amount and cost sharing instead of treating its balance as an insured deductible. |
| Good faith estimate | [CMS patient-provider dispute guidance](https://www.cms.gov/initiatives/your-patient-rights/medical-bill-rights/get-help/dispute-bill). Compare a single same-biller care episode to its written estimate, with an inclusive `$400` amount screen and up to 120 calendar days from the initial bill. A flag requests eligibility review; it does not file a dispute or guarantee eligibility. The fixture check date is fixed for replay. The insured emergency-billing protections are outside scope. |
| Charity care | [2026 HHS poverty guidelines](https://www.govinfo.gov/content/pkg/FR-2026-01-15/html/2026-00755.htm) for the contiguous states and DC, Alaska and Hawaii. Divide annual income by the relevant household guideline. The 200% and 400% bands are example bands, not a universal eligibility rule. [IRS section 501(r)(4)](https://www.irs.gov/charities-non-profits/financial-assistance-policy-and-emergency-medical-care-policy-section-501r4) requires covered hospitals to publish their eligibility criteria and practices. |

Procedure labels are short original paraphrases for teaching. The project does not ship downloadable source tables or source descriptors. CPT is a registered trademark of the American Medical Association. Check the applicable source and code-use terms before public redistribution. Data edition `clearbill-2026q4-v1` is fixed for replay, not silently updated.

Source archive fingerprints for reproduction:

| CMS archive | SHA-256 |
| --- | --- |
| `rvu26d-updated-08-26-2026.zip` | `521ff0f4ecbf13b5d99dc1dc04d9f82e5361e55c6b4b6b3033043598bf8406e6` |
| `medicare-ncci-2026-q4-practitioner-services-mue-table.zip` | `4574336755ba4e49b7c8ec07de5b74d3f0b8593e3e6192013631724981180d00` |

## Export boundaries

- CSV contains typed cents, formula-neutralized text, findings, balance checks and estimate observations where applicable. Open only exports from a trusted locale/workflow.
- JSON records contain allowed fictional identifiers and bounded structured values. The canonical form uses sorted object keys, UTF-8, original array order and integer JSON. The SHA-256 replay verifier rejects malformed schemas, unsupported rule versions, mismatching results and mismatching digests. It does not authenticate a sender.
- An AES-256-GCM summary contains only a version, fictional preset ID and locality, never custom lines or values. Web Crypto generates a new random 256-bit key and 96-bit IV per seal. The ciphertext is in the URL fragment, not the HTTP request. The app removes it from the visible URL on open. Deliver the key by a separate channel. Anyone who has both can open the fictional summary; do not treat the feature as appropriate for real records.
- Nothing is sent in the background. Source hyperlinks are ordinary opt-in navigation. No tracking, analytics, sign-in, external assets or runtime packages.

## Verify

```sh
nice -n 15 npm test
npm run test:browser
```

The Node suite checks independently calculated references, published unit limits, threshold and time boundaries, exact-cent reconciliation, bounded input perturbations, both export formats and authenticated decryption. The Chrome check uses a throwaway headless profile with no logged-in accounts. Set `CHROME_PATH` if the Chrome executable differs. It tests both layouts, in-browser imports and exports, service worker control, an offline reload and actual Letter PDF page counts for both worksheet languages. It captures `docs/desktop.png`, `docs/dispute.png` and `docs/mobile.png`.

The synthetic checks demonstrate expected behavior on known inputs, not precision or recall across patient bills, measured savings, or patient outcomes.
