/**
 * r220 (item 61c2e30f) — THE EA FIELD REGISTER: every box on the C.P.8A, what it says, and what feeds it.
 *
 * WHAT THE REPORTER ASKED FOR AND WHY THIS IS THE ANSWER. The EA is drawn to the agency's own arrangement
 * (lib/ea-pdf.ts, r219) and the payroll figures are already mapped into it — but there was no written list
 * of the form's boxes anywhere, so "is the EA right?" was a question only somebody who could read the
 * renderer could answer. This is that list: one row per box, carrying the form's own section, the form's
 * own box number, the agency's own Malay wording, the kind of value the box takes, and what feeds it today
 * — or `nothing feeds this yet`, said in as many words rather than left blank.
 *
 * ⚠️ IT IS DATA, NOT PROSE, AND THAT IS THE POINT. `docs/forms/ea-cp8a-field-register.md` is GENERATED from
 * this file (scripts/gen-ea-field-register.ts) and test/ea-form-boxes-contract.test.ts holds the register
 * and the renderer to each other in BOTH directions:
 *   • a row here whose caption nothing draws fails, and
 *   • a caption or a figure the renderer draws that no row here names fails.
 * A hand-written document would have been correct on the day it was written and quietly wrong ever after —
 * which is the state the form's mapping was already in, and the reason this item exists.
 *
 * WHERE THE WORDING COMES FROM. `docs/forms/ea-cp8a-pin-2024-transcription.txt`, the hand transcription of
 * the specimen, is the authority for every `wording` below, and the contract test refuses one that is not
 * in it. The agency's page furniture (the form number, the masthead, the banner, the officer box) is not
 * retyped at all — it is read straight out of `EA_FORM_WORDS`, the same constant the renderer draws from,
 * so those rows cannot drift from the page even in principle.
 *
 * WHAT IT IS NOT. It is not a claim about what LHDN publishes. Everything here describes THIS repository's
 * rendering of the C.P.8A arrangement — `agency-layout`, never `official` (AGENTS 28b).
 */
import { EA_FORM_WORDS, type EaPdfLabels } from './ea-pdf';

/** The form's own divisions, in the order they appear down the page. `BELOW` and `META` are ours. */
export type EaRegisterSection = 'HEADER' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'FOOT' | 'BELOW' | 'META';

/**
 * What kind of value the box takes. `heading` is a box that takes NO value — a section title, the column's
 * "RM", the masthead — and it is a distinct kind rather than an empty `valueType` so that the contract
 * test's "a value box with no source must say so" rule cannot be satisfied by mislabelling one.
 */
export type EaRegisterValue = 'heading' | 'text' | 'date' | 'year' | 'count' | 'money' | 'description' | 'note';

/**
 * What feeds the box TODAY. `none` is the honest answer for a box the agency asks for and this system
 * holds nothing for — the employer's own serial number, the description rules inside 1(c) / 3 / 4, the
 * gratuity period, the signing date. The register prints it as "nothing feeds this yet" rather than
 * leaving the cell empty, because an empty cell reads as an oversight in the document.
 */
export type EaRegisterFeed =
  | 'payroll'
  | 'payroll+amendment'
  | 'amendment'
  | 'staff'
  | 'company'
  | 'derived'
  | 'form'
  | 'system'
  | 'none';

export const EA_REGISTER_NOTHING_FEEDS = 'nothing feeds this yet';

const FEED_TEXT: Record<EaRegisterFeed, string> = {
  payroll: 'Payroll — the year’s payslips',
  'payroll+amendment': 'Payroll, and amendable under “Amend EA figures”',
  amendment: 'Only “Amend EA figures” — no payroll source exists',
  staff: 'The employee’s staff record',
  company: 'The employer’s company record',
  derived: 'Added up from the boxes above it on this form',
  form: 'The form itself — printed on every copy, nothing goes in it',
  system: 'Filled in by this system',
  none: EA_REGISTER_NOTHING_FEEDS,
};

/**
 * Where the caption on the page comes from.
 *   • `agency` — one of `EA_FORM_WORDS`, drawn in Malay in BOTH languages because it is the agency's own
 *     page furniture and translating it produces a document that no longer matches the form.
 *   • `label`  — one of `EaPdfLabels`, resolved from the `payroll.ea` namespace, so the reader gets the
 *     form's captions in their own language with the form's OWN numbering inside them.
 */
export type EaRegisterCaption =
  | { from: 'agency'; key: keyof typeof EA_FORM_WORDS }
  | { from: 'label'; key: keyof EaPdfLabels };

export type EaRegisterRow = {
  section: EaRegisterSection;
  /** The form's own numbering, exactly as the form prints it. Empty for a box the form does not number. */
  box: string;
  /**
   * The agency's own words. For an `agency` caption this is read from `EA_FORM_WORDS` at build time and
   * is not retyped here; for a `label` caption it is the Malay from the transcription, and the contract
   * test refuses any string that is not in `docs/forms/ea-cp8a-pin-2024-transcription.txt`.
   *
   * EMPTY only for the three lines below the form and the PDF's own title, which are ours and have no
   * agency wording to be checked against.
   */
  wording: string;
  caption: EaRegisterCaption;
  value: EaRegisterValue;
  /** `EaPdfData` paths the renderer reads for this box, dotted and without the leading `d.`. */
  sources: string[];
  feed: EaRegisterFeed;
  /** One sentence, when the row needs one. Printed in the register's own Notes column. */
  note?: string;
};

const agency = (key: keyof typeof EA_FORM_WORDS): EaRegisterCaption => ({ from: 'agency', key });
const label = (key: keyof EaPdfLabels): EaRegisterCaption => ({ from: 'label', key });

/**
 * EVERY BOX ON THE PAGE, IN THE ORDER IT IS DRAWN.
 *
 * Order matters: this is the list somebody works down with LHDN's own form beside them, so it follows the
 * page rather than the data model.
 */
export const EA_REGISTER: EaRegisterRow[] = [
  // ── The header band ───────────────────────────────────────────────────────────────────────────────
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.formNo, caption: agency('formNo'), value: 'heading', sources: [], feed: 'form',
    note: 'The edition this page is drawn to. Changing it means re-tracing the form.' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.serialNo, caption: agency('serialNo'), value: 'text', sources: [], feed: 'none',
    note: 'The employer’s own running number for the statements it issues. Nothing in this system holds it, and the rule is printed empty.' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.employerTin, caption: agency('employerTin'), value: 'text', sources: ['employer.eNumber'], feed: 'company' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.masthead1, caption: agency('masthead1'), value: 'heading', sources: [], feed: 'form' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.masthead2, caption: agency('masthead2'), value: 'heading', sources: [], feed: 'form' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.masthead3, caption: agency('masthead3'), value: 'heading', sources: [], feed: 'form' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.masthead4, caption: agency('masthead4'), value: 'year', sources: ['year'], feed: 'system',
    note: 'The one masthead line that is COMPLETED rather than printed: the year of assessment is appended. The blank copy leaves it open.' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.privateStatement, caption: agency('privateStatement'), value: 'heading', sources: [], feed: 'form' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.ea, caption: agency('ea'), value: 'heading', sources: [], feed: 'form' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.employeeTin, caption: agency('employeeTin'), value: 'text', sources: ['employee.taxNo'], feed: 'staff' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.lhdnState, caption: agency('lhdnState'), value: 'text', sources: ['employer.lhdnState'], feed: 'company' },
  { section: 'HEADER', box: '', wording: EA_FORM_WORDS.banner, caption: agency('banner'), value: 'heading', sources: [], feed: 'form' },

  // ── A — Butiran Pekerja ───────────────────────────────────────────────────────────────────────────
  { section: 'A', box: 'A', wording: 'BUTIRAN PEKERJA', caption: label('sectionAEmployeeParticulars'), value: 'heading', sources: [], feed: 'form' },
  { section: 'A', box: '1', wording: 'Nama Penuh Pekerja / Pesara (Encik/Cik/Puan)', caption: label('name'), value: 'text', sources: ['employee.name'], feed: 'staff' },
  { section: 'A', box: '2', wording: 'Jawatan', caption: label('jobTitle'), value: 'text', sources: ['employee.jobTitle'], feed: 'staff',
    note: 'The title on the assignment in force at the END of the employment’s year — a leaver has one, an open assignment is not required.' },
  { section: 'A', box: '3', wording: 'No. Kakitangan / No. Gaji', caption: label('employeeNo'), value: 'text', sources: ['employee.employeeNo'], feed: 'staff' },
  { section: 'A', box: '4', wording: 'No. K.P. Baru', caption: label('icNo'), value: 'text', sources: ['employee.ic'], feed: 'staff' },
  { section: 'A', box: '5', wording: 'No. Pasport', caption: label('passportNo'), value: 'text', sources: ['employee.passport'], feed: 'staff' },
  { section: 'A', box: '6', wording: 'No. KWSP', caption: label('epfNo'), value: 'text', sources: ['employee.epfNo'], feed: 'staff' },
  { section: 'A', box: '7', wording: 'No. PERKESO', caption: label('socsoNo'), value: 'text', sources: ['employee.socsoNo'], feed: 'staff' },
  { section: 'A', box: '8', wording: 'Bilangan anak yang layak untuk pelepasan cukai', caption: label('childrenTaxRelief'), value: 'count', sources: ['employee.children'], feed: 'staff' },
  { section: 'A', box: '9', wording: 'Jika bekerja tidak genap setahun, nyatakan:', caption: label('partYearNote'), value: 'heading', sources: [], feed: 'form' },
  { section: 'A', box: '9(a)', wording: 'Tarikh mula bekerja', caption: label('startedOn'), value: 'date', sources: ['employee.hiredOn'], feed: 'staff',
    note: 'Printed ONLY when the date falls inside the selected year of assessment — the form asks for it only when the employment did not run the whole year.' },
  { section: 'A', box: '9(b)', wording: 'Tarikh berhenti kerja', caption: label('leftOn'), value: 'date', sources: ['employee.terminatedOn'], feed: 'staff',
    note: 'Same condition as 9(a), decided on its own date: a leaver hired years ago shows a leaving date and an empty commencement rule.' },

  // ── B — Pendapatan Penggajian, Manfaat dan Tempat Kediaman ────────────────────────────────────────
  { section: 'B', box: 'B', wording: 'PENDAPATAN PENGGAJIAN, MANFAAT DAN TEMPAT KEDIAMAN', caption: label('sectionBEmploymentIncome'), value: 'heading', sources: [], feed: 'form' },
  { section: 'B', box: '', wording: '(Tidak Termasuk Elaun / Perkuisit / Pemberian / Manfaat Yang Dikecualikan Cukai)', caption: label('sectionBExcluding'), value: 'heading', sources: [], feed: 'form' },
  { section: 'B', box: '', wording: EA_FORM_WORDS.rm, caption: agency('rm'), value: 'heading', sources: [], feed: 'form',
    note: 'Printed ONCE, over the right-hand money column, for the whole form.' },
  { section: 'B', box: '1(a)', wording: 'Gaji kasar, upah atau gaji cuti (termasuk gaji lebih masa)', caption: label('grossSalary'), value: 'money', sources: ['partB.grossSalary'], feed: 'payroll+amendment' },
  { section: 'B', box: '1(b)', wording: 'Fi (termasuk fi pengarah), komisen atau bonus', caption: label('feesCommissionBonus'), value: 'money', sources: ['partB.bonus', 'partB.directorFee'], feed: 'payroll+amendment',
    note: 'ONE agency box over TWO of our figures: bonus (payroll) plus director’s fees / commission (amendment only). Prints only when the sum is non-zero, because half of it has no payroll source.' },
  { section: 'B', box: '1(c)', wording: 'Tip kasar, perkuisit, penerimaan sagu hati atau elaun-elaun lain', caption: label('tipsPerquisitesOther'), value: 'money', sources: ['partB.allowances', 'partB.tipsPerquisites'], feed: 'payroll+amendment',
    note: 'ONE agency box over TWO of our figures: allowances (payroll) plus tips / perquisites (amendment only). Same rule as 1(b).' },
  { section: 'B', box: '1(c)', wording: 'Perihal pembayaran:', caption: label('paymentDetail'), value: 'description', sources: [], feed: 'none',
    note: 'The description rule inside 1(c). Writing a description we do not hold would be inventing a fact about somebody’s pay, so the rule stays empty.' },
  { section: 'B', box: '1(d)', wording: 'Cukai pendapatan yang dibayar oleh majikan bagi pihak pekerja', caption: label('taxBorneByEmployer'), value: 'money', sources: ['partB.taxBorneByEmployer'], feed: 'amendment' },
  { section: 'B', box: '1(e)', wording: 'Manfaat Skim Opsyen Saham Pekerja (ESOS)', caption: label('esos'), value: 'money', sources: ['partB.esos'], feed: 'amendment' },
  { section: 'B', box: '1(f)', wording: 'Ganjaran bagi tempoh dari _ hingga _', caption: label('gratuity'), value: 'money', sources: ['partB.gratuity'], feed: 'amendment' },
  { section: 'B', box: '1(f)', wording: 'dari', caption: label('periodFrom'), value: 'date', sources: [], feed: 'none',
    note: 'The first of 1(f)’s two period rules. The gratuity period is not a fact this system holds.' },
  { section: 'B', box: '1(f)', wording: 'hingga', caption: label('periodTo'), value: 'date', sources: [], feed: 'none',
    note: 'The second of 1(f)’s two period rules.' },
  { section: 'B', box: '2', wording: 'Butiran bayaran tunggakan dan lain-lain bagi tahun-tahun terdahulu dalam tahun semasa', caption: label('arrears'), value: 'money', sources: ['partB.arrears'], feed: 'amendment' },
  { section: 'B', box: '2', wording: 'Jenis pendapatan', caption: label('incomeType'), value: 'description', sources: [], feed: 'none',
    note: 'Item 2’s sub-line, with a rule at (a) and (b). Both carry a description and no money; the amount belongs to item 2 itself.' },
  { section: 'B', box: '3', wording: 'Manfaat berupa barangan', caption: label('benefitsInKind'), value: 'money', sources: ['partB.benefitsInKind'], feed: 'amendment' },
  { section: 'B', box: '3', wording: 'Nyatakan:', caption: label('stateWhat'), value: 'description', sources: [], feed: 'none', note: 'The description rule inside item 3.' },
  { section: 'B', box: '4', wording: 'Nilai tempat kediaman', caption: label('livingAccommodation'), value: 'money', sources: ['partB.livingAccommodation'], feed: 'amendment' },
  { section: 'B', box: '4', wording: 'Alamat:', caption: label('addressCue'), value: 'description', sources: [], feed: 'none', note: 'The address rule inside item 4.' },
  { section: 'B', box: '5', wording: 'Bayaran balik daripada Kumpulan Wang Simpanan / Pencen yang tidak diluluskan', caption: label('unapprovedFundRefund'), value: 'money', sources: ['partB.unapprovedFundRefund'], feed: 'amendment' },
  { section: 'B', box: '6', wording: 'Pampasan kerana kehilangan pekerjaan', caption: label('compensation'), value: 'money', sources: ['partB.compensation'], feed: 'amendment' },

  // ── C — Pencen dan Lain-lain, closed by the form's single JUMLAH ──────────────────────────────────
  { section: 'C', box: 'C', wording: 'PENCEN DAN LAIN-LAIN', caption: label('sectionCPensionOther'), value: 'heading', sources: [], feed: 'form' },
  { section: 'C', box: '1', wording: 'Pencen', caption: label('pension'), value: 'money', sources: ['partC.pension'], feed: 'amendment',
    note: 'This product pays no pensions, so there is no payroll source and never has been.' },
  { section: 'C', box: '2', wording: 'Anuiti atau bayaran berkala yang lain', caption: label('annuity'), value: 'money', sources: ['partC.annuity'], feed: 'amendment' },
  { section: 'C', box: '', wording: 'JUMLAH', caption: label('formTotal'), value: 'money', sources: ['partB.gross', 'partC.total'], feed: 'derived',
    note: 'The form’s ONLY total, closed with a double rule. It totals B and C together — the two subtotals our own earlier layout had are not on the agency’s page.' },

  // ── D — Jumlah Potongan ──────────────────────────────────────────────────────────────────────────
  { section: 'D', box: 'D', wording: 'JUMLAH POTONGAN', caption: label('sectionDTotalDeductions'), value: 'heading', sources: [], feed: 'form' },
  { section: 'D', box: '1', wording: 'Potongan cukai bulanan (PCB) yang dibayar kepada LHDNM', caption: label('monthlyTaxDeduction'), value: 'money', sources: ['partD.mtd'], feed: 'payroll+amendment' },
  { section: 'D', box: '2', wording: 'Arahan potongan CP38 yang dibayar kepada LHDNM', caption: label('cp38Deductions'), value: 'money', sources: ['partD.cp38'], feed: 'payroll+amendment' },
  { section: 'D', box: '3', wording: 'Zakat yang dibayar melalui potongan gaji', caption: label('zakatViaSalary'), value: 'money', sources: ['partD.zakat'], feed: 'payroll+amendment' },
  { section: 'D', box: '4', wording: 'Derma / hadiah / sumbangan diluluskan yang dibayar melalui potongan gaji', caption: label('donations'), value: 'money', sources: ['partD.donations'], feed: 'amendment' },
  { section: 'D', box: '5', wording: 'Jumlah tuntutan potongan oleh pekerja melalui Borang TP1 berkaitan:', caption: label('tp1ClaimHeading'), value: 'heading', sources: [], feed: 'form' },
  { section: 'D', box: '5(a)', wording: 'Pelepasan', caption: label('tp1Relief'), value: 'money', sources: ['partD.tp1Relief'], feed: 'payroll+amendment',
    note: 'Derived from the year’s APPROVED TP1 declarations. Prints its own “RM” and rule at mid-page; the right-hand column stays empty on this line.' },
  { section: 'D', box: '5(b)', wording: 'Zakat selain yang dibayar melalui potongan gaji bulanan', caption: label('zakatOther'), value: 'money', sources: ['partD.zakatOther'], feed: 'amendment',
    note: 'Mid-page “RM” and rule, like 5(a).' },
  { section: 'D', box: '6', wording: 'Jumlah pelepasan bagi anak yang layak', caption: label('childRelief'), value: 'money', sources: ['partD.childRelief'], feed: 'amendment' },

  // ── E — Caruman kepada Kumpulan Wang Simpanan / Pencen yang Diluluskan dan PERKESO ────────────────
  { section: 'E', box: 'E', wording: 'CARUMAN YANG DIBAYAR OLEH PEKERJA KEPADA KUMPULAN WANG SIMPANAN / PENCEN YANG DILULUSKAN DAN PERKESO', caption: label('sectionEContributions'), value: 'heading', sources: [], feed: 'form' },
  { section: 'E', box: '1', wording: 'Nama Kumpulan Wang', caption: label('fundName'), value: 'text', sources: ['partE.fundName'], feed: 'payroll' },
  { section: 'E', box: '1', wording: 'Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja)', caption: label('contributionAmount'), value: 'money', sources: ['partE.epf'], feed: 'payroll+amendment',
    note: 'The employee’s share only. The same caption is printed again on item 2, after the agency’s “2. PERKESO:”.' },
  { section: 'E', box: '2', wording: EA_FORM_WORDS.perkeso, caption: agency('perkeso'), value: 'money', sources: ['partE.socso'], feed: 'payroll+amendment',
    note: 'The item number and the word PERKESO are the agency’s and are printed in Malay in both languages; the caption after them is item 1’s.' },

  // ── F — Jumlah Elaun / Perkuisit / Pemberian / Manfaat yang Dikecualikan Cukai ────────────────────
  { section: 'F', box: 'F', wording: 'JUMLAH ELAUN / PERKUISIT / PEMBERIAN / MANFAAT YANG DIKECUALIKAN CUKAI', caption: label('sectionFExemptAllowances'), value: 'money', sources: ['partB.exemptAllowances'], feed: 'payroll',
    note: 'ONE line: the section title IS the item. The figure is the year’s tax-exempt allowance portions, which are a PART of 1(c) and not an addition to it.' },

  // ── The foot — the signing date and the ruled officer box ─────────────────────────────────────────
  { section: 'FOOT', box: '', wording: EA_FORM_WORDS.date, caption: agency('date'), value: 'date', sources: [], feed: 'none',
    note: 'The date the employer SIGNS the statement. Theirs to write, not ours to invent, so the rule prints empty on a filled form too.' },
  { section: 'FOOT', box: '', wording: EA_FORM_WORDS.officerName, caption: agency('officerName'), value: 'text', sources: ['employer.officerName'], feed: 'company',
    note: '“Name Pegawai” is the SPECIMEN’S own spelling — Malay would be “Nama”. Reproduced as the agency’s form has it and deliberately not corrected.' },
  { section: 'FOOT', box: '', wording: EA_FORM_WORDS.officerPosition, caption: agency('officerPosition'), value: 'text', sources: ['employer.officerPosition'], feed: 'company' },
  { section: 'FOOT', box: '', wording: EA_FORM_WORDS.employerNameAddress, caption: agency('employerNameAddress'), value: 'text', sources: ['employer.name', 'employer.address'], feed: 'company',
    note: 'TWO rules: the employer’s name on the first, the address folded onto the second. The form has no third rule.' },
  { section: 'FOOT', box: '', wording: EA_FORM_WORDS.employerPhone, caption: agency('employerPhone'), value: 'text', sources: ['employer.phone'], feed: 'company' },

  // ── Below the form — OUR strip, in the space the specimen leaves empty ────────────────────────────
  { section: 'BELOW', box: '', wording: '', caption: label('eisSip'), value: 'money', sources: ['partE.eis'], feed: 'payroll',
    note: 'NOT a box on the C.P.8A: the official Section E carries exactly two amounts and EIS is not one of them. The employee’s own EIS deduction is real and they may need it, so it is printed below the form with “RM” spelled out.' },
  { section: 'BELOW', box: '', wording: '', caption: label('disclaimer'), value: 'note', sources: [], feed: 'system',
    note: 'Ours. Names the year of assessment and the statutory table version, says which boxes payroll fed, and says the page is our rendering of the agency’s arrangement. The blank copy carries a different sentence, because none of that is true of a blank.' },
  { section: 'BELOW', box: '', wording: '', caption: label('amendedNote'), value: 'note', sources: ['overrides'], feed: 'system',
    note: 'Printed only when HR has amended at least one figure on this statement.' },

  // ── Not on the page at all ───────────────────────────────────────────────────────────────────────
  { section: 'META', box: '', wording: '', caption: label('title'), value: 'note', sources: ['year'], feed: 'system',
    note: 'The PDF’s document title — the browser tab and the file’s properties. Nothing is drawn from it.' },
];

const SECTION_TITLE: Record<EaRegisterSection, string> = {
  HEADER: 'Header band',
  A: 'A — Butiran Pekerja (employee particulars)',
  B: 'B — Pendapatan Penggajian, Manfaat dan Tempat Kediaman (employment income, benefits, accommodation)',
  C: 'C — Pencen dan Lain-lain (pension and others)',
  D: 'D — Jumlah Potongan (total deductions)',
  E: 'E — Caruman … Kumpulan Wang Simpanan / Pencen yang Diluluskan dan PERKESO (contributions)',
  F: 'F — Jumlah Elaun … yang Dikecualikan Cukai (total exempt allowances)',
  FOOT: 'The foot — signing date and officer box',
  BELOW: 'Below the form — our own strip',
  META: 'Not drawn on the page',
};

const VALUE_TEXT: Record<EaRegisterValue, string> = {
  heading: 'heading (takes no value)',
  text: 'text',
  date: 'date',
  year: 'year',
  count: 'whole number',
  money: 'amount (RM)',
  description: 'free text the form asks for',
  note: 'sentence',
};

/** Pipes and newlines would break a Markdown table cell; nothing else needs escaping here. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/**
 * The register as the Markdown document shipped at `docs/forms/ea-cp8a-field-register.md` and offered from
 * the Statutory Forms shelf.
 *
 * PURE, and it takes no arguments: the download route serves exactly what the checked-in document says,
 * so an operator's copy and the repository's copy cannot disagree — and the deploy does not have to carry
 * `docs/` for the download to work.
 */
export function renderEaFieldRegisterMarkdown(): string {
  const out: string[] = [];
  out.push('# EA (C.P.8A Pin. 2023) — field register');
  out.push('');
  out.push('Every box on the EA form as this system draws it: the form’s own section, the form’s own box');
  out.push('number, the agency’s own wording, the kind of value the box takes, and what feeds it today —');
  out.push(`or “${EA_REGISTER_NOTHING_FEEDS}”, said in as many words.`);
  out.push('');
  out.push('**Hold this beside a blank C.P.8A and work down it.** The blank copy this system produces is on');
  out.push('the Statutory Forms screen, beside each of the two EA rows (“Download blank EA form”).');
  out.push('');
  out.push('**What this page is not.** The EA is drawn to the C.P.8A (Pin. 2023) arrangement on paper of');
  out.push('ours — we hold no blank C.P.8A from LHDN to print onto — so this register describes our');
  out.push('rendering of that arrangement, not agency artwork. The wording in the third column is taken from');
  out.push('`docs/forms/ea-cp8a-pin-2024-transcription.txt`, the hand transcription of the specimen.');
  out.push('');
  out.push('**This file is generated.** Edit `lib/ea-field-register.ts` and run');
  out.push('`pnpm tsx scripts/gen-ea-field-register.ts`. `test/ea-form-boxes-contract.test.ts` fails if a row');
  out.push('here names a caption nothing draws, if the renderer draws a box no row here names, or if this');
  out.push('file is out of date.');
  out.push('');
  out.push('The last column is the internal name of the caption, so a wording that needs changing can be');
  out.push('pointed at exactly. `payroll.ea.*` captions are translated into every language the product has;');
  out.push('`form.*` captions are the agency’s own Malay words and are printed in Malay whatever language');
  out.push('the reader has chosen.');

  for (const section of Object.keys(SECTION_TITLE) as EaRegisterSection[]) {
    const rows = EA_REGISTER.filter((r) => r.section === section);
    if (rows.length === 0) continue;
    out.push('');
    out.push(`## ${SECTION_TITLE[section]}`);
    out.push('');
    out.push('| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const captionName = r.caption.from === 'agency' ? `form.${r.caption.key}` : `payroll.ea.${r.caption.key}`;
      const feed = FEED_TEXT[r.feed] + (r.sources.length ? ` (${r.sources.join(', ')})` : '');
      out.push(
        `| ${cell(r.section)} | ${cell(r.box)} | ${cell(r.wording) || '—'} | ${cell(VALUE_TEXT[r.value])} | ${cell(feed)} | ${cell(r.note ?? '')} | \`${cell(captionName)}\` |`,
      );
    }
  }

  const unfed = EA_REGISTER.filter((r) => r.feed === 'none');
  out.push('');
  out.push('## Boxes nothing feeds yet');
  out.push('');
  out.push(`${unfed.length} of the ${EA_REGISTER.length} entries in this register take a value the agency asks`);
  out.push('for and this system holds nothing for. Each prints the blank form’s own rule and nothing on it —');
  out.push('never a placeholder, never `0.00`, never a plausible guess. They are listed again here because');
  out.push('they are the shortest answer to “what is still missing from the EA?”.');
  out.push('');
  for (const r of unfed) {
    out.push(`- **${r.section}${r.box ? ` ${r.box}` : ''}** — ${r.wording || `\`${r.caption.key}\``}${r.note ? ` — ${r.note}` : ''}`);
  }
  out.push('');
  return out.join('\n');
}
