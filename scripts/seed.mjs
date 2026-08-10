// Inserts the document corpus with embeddings. Embeddings are computed in JS, so this
// lives here rather than in db/init.sql.
import { pool, query } from '../src/db.js';
import { embed, toVectorLiteral } from '../src/embed.js';

const DOCUMENTS = [
  {
    doc_id: 'TRM20-CONTRACT-01',
    title: 'SecureTerm 20-Year — Policy Contract, Article 3: Death Benefit',
    doc_type: 'contract',
    product_code: 'TRM-20',
    content:
      'The death benefit is payable to the named beneficiary upon receipt of due proof of death of the insured while this policy is in force. The death benefit equals the face amount shown in the policy schedule, less any outstanding policy loan balance and less any premium due and unpaid through the date of death. If the insured dies during the grace period, the death benefit is reduced by the premium then due. Payment is made in a single sum unless a settlement option has been elected.',
  },
  {
    doc_id: 'TRM20-CONTRACT-02',
    title: 'SecureTerm 20-Year — Policy Contract, Article 7: Suicide Exclusion',
    doc_type: 'contract',
    product_code: 'TRM-20',
    content:
      'If the insured dies by suicide, while sane or insane, within two years from the policy date, the death benefit will be limited to the sum of premiums paid, without interest, less any outstanding loan balance. This two-year period restarts with respect to any increase in face amount, measured from the effective date of that increase. In states where a shorter statutory period applies, the shorter period governs.',
  },
  {
    doc_id: 'TRM20-CONTRACT-03',
    title: 'SecureTerm 20-Year — Policy Contract, Article 9: Grace Period and Reinstatement',
    doc_type: 'contract',
    product_code: 'TRM-20',
    content:
      'A grace period of thirty-one days is allowed for payment of each premium after the first. The policy remains in force during the grace period. If the premium is not paid by the end of the grace period, the policy lapses without value. A lapsed policy may be reinstated within five years of the date of lapse upon written application, evidence of insurability satisfactory to the company, and payment of all overdue premiums with interest at six percent compounded annually.',
  },
  {
    doc_id: 'GUIDE-UW-01',
    title: 'Underwriting Guidelines — Accelerated Underwriting Eligibility',
    doc_type: 'underwriting_guideline',
    product_code: 'TRM-20',
    content:
      'Applicants aged 18 through 44 applying for face amounts of $250,000 or less may qualify for accelerated underwriting, which waives the paramedical examination and fluid collection. Eligibility additionally requires a clean prescription history check, a motor vehicle record with no major violations in the past three years, and no tobacco use disclosed in the past twelve months. Applicants who fail any accelerated screen are routed to the full underwriting path rather than declined.',
  },
  {
    doc_id: 'GUIDE-UW-02',
    title: 'Underwriting Guidelines — Build Chart and Table Ratings',
    doc_type: 'underwriting_guideline',
    product_code: 'TRM-30',
    content:
      'Body mass index is calculated from height and weight recorded at the paramedical examination. A body mass index at or below 33 is eligible for standard rates. Between 33 and 38, a table rating of Table B applies. Above 38, the application is rated up to Table D or referred, depending on comorbidities. Applicants with a body mass index above 45 are declined absent compelling favorable evidence. Build ratings are combined with any debits assessed for cardiovascular or metabolic history.',
  },
  {
    doc_id: 'GUIDE-UW-03',
    title: 'Underwriting Guidelines — Financial Justification for Large Face Amounts',
    doc_type: 'underwriting_guideline',
    product_code: 'UL-200',
    content:
      'Income replacement coverage is generally justified at a multiple of annual earned income based on the applicant age: up to 30 times for ages 18 to 40, 20 times for ages 41 to 50, 15 times for ages 51 to 60, and 10 times thereafter. Requests exceeding these multiples require a written cover letter and supporting financial documentation such as tax returns or audited financial statements. Face amounts above five million dollars require facultative reinsurance review before an offer is made.',
  },
  {
    doc_id: 'RIDER-WP-01',
    title: 'Waiver of Premium Rider — Terms and Conditions',
    doc_type: 'rider',
    product_code: 'TRM-20',
    content:
      'The waiver of premium rider waives premiums falling due while the insured is totally disabled, provided the disability begins before the policy anniversary nearest age sixty and continues for at least six consecutive months. Total disability means the inability to perform the material duties of the insured occupation for the first twenty-four months, and thereafter the inability to perform the duties of any occupation for which the insured is reasonably suited by education, training or experience. Written notice of claim must be given within one year of the start of disability.',
  },
  {
    doc_id: 'RIDER-ADB-01',
    title: 'Accelerated Death Benefit Rider — Chronic and Terminal Illness',
    doc_type: 'rider',
    product_code: 'WL-100',
    content:
      'The accelerated death benefit rider allows the owner to receive a portion of the death benefit during the insured lifetime upon certification of a terminal illness with a life expectancy of twelve months or less, or a chronic illness preventing performance of at least two activities of daily living. The maximum acceleration is the lesser of eighty percent of the death benefit or five hundred thousand dollars. Amounts accelerated reduce the death benefit payable and may be taxable. Receipt of accelerated benefits may affect eligibility for public assistance programs.',
  },
  {
    doc_id: 'WL100-CONTRACT-01',
    title: 'Heritage Whole Life — Policy Contract, Article 5: Cash Value and Policy Loans',
    doc_type: 'contract',
    product_code: 'WL-100',
    content:
      'The policy accumulates guaranteed cash value according to the table of values in the policy schedule. The owner may borrow against the cash value at an annual interest rate of five percent payable in advance. Any outstanding loan plus accrued interest is deducted from the death benefit or from the cash surrender value. If the outstanding loan balance equals or exceeds the cash value, the policy terminates thirty-one days after notice is mailed to the owner at the last known address.',
  },
  {
    doc_id: 'DISC-VUL-01',
    title: 'Horizon Variable UL — Suitability and Risk Disclosure',
    doc_type: 'disclosure',
    product_code: 'VUL-300',
    content:
      'Variable universal life insurance places the investment risk on the policy owner. Account values fluctuate with the performance of the selected subaccounts and may lose value. Poor subaccount performance may require additional premium payments to keep the policy in force; the policy may lapse if the account value is insufficient to cover monthly deductions. A completed suitability questionnaire and a signed acknowledgement of the prospectus are required before the policy may be issued. This product is not appropriate for applicants seeking guaranteed cash value.',
  },
  {
    doc_id: 'PROC-CLAIM-01',
    title: 'Claims Procedure — Contestability Investigation',
    doc_type: 'procedure',
    product_code: null,
    content:
      'A claim arising within two years of the policy date or of reinstatement is subject to a contestability investigation. The claims examiner orders an attending physician statement and a pharmacy history covering the five years preceding the application. Material misrepresentation discovered during the contestability period permits rescission of the policy and return of premiums paid. After the contestability period expires, the company may not contest the policy except for nonpayment of premium or fraudulent misstatement of age or sex where state law permits.',
  },
  {
    doc_id: 'PROC-REQ-01',
    title: 'New Business Procedure — Outstanding Requirements Follow-Up',
    doc_type: 'procedure',
    product_code: null,
    content:
      'Outstanding requirements are followed up on a fourteen day cycle. The first follow-up is a system-generated notice to the ordering vendor and the writing agent. The second follow-up at twenty-eight days escalates to the case manager. Applications with requirements outstanding beyond ninety days are closed as incomplete and must be resubmitted with a new application. Attending physician statements are the most common cause of delay and should be ordered on the day the application is received rather than after the exam is completed.',
  },
];

async function main() {
  await query('DELETE FROM policy_documents');

  for (const doc of DOCUMENTS) {
    const embedding = toVectorLiteral(embed(`${doc.title}\n${doc.content}`));
    await query(
      `INSERT INTO policy_documents (doc_id, title, doc_type, product_code, content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [doc.doc_id, doc.title, doc.doc_type, doc.product_code, doc.content, embedding],
    );
  }

  console.log(`Seeded ${DOCUMENTS.length} policy documents.`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
