# EA (C.P.8A Pin. 2023) — field register

Every box on the EA form as this system draws it: the form’s own section, the form’s own box
number, the agency’s own wording, the kind of value the box takes, and what feeds it today —
or “nothing feeds this yet”, said in as many words.

**Hold this beside a blank C.P.8A and work down it.** The blank copy this system produces is on
the Statutory Forms screen, beside each of the two EA rows (“Download blank EA form”).

**What this page is not.** The EA is drawn to the C.P.8A (Pin. 2023) arrangement on paper of
ours — we hold no blank C.P.8A from LHDN to print onto — so this register describes our
rendering of that arrangement, not agency artwork. The wording in the third column is taken from
`docs/forms/ea-cp8a-pin-2023-transcription.txt`, the hand transcription of the specimen.

**This file is generated.** Edit `lib/ea-field-register.ts` and run
`pnpm tsx scripts/gen-ea-field-register.ts`. `test/ea-form-boxes-contract.test.ts` fails if a row
here names a caption nothing draws, if the renderer draws a box no row here names, or if this
file is out of date.

The last column is the internal name of the caption, so a wording that needs changing can be
pointed at exactly. `payroll.ea.*` captions are translated into every language the product has;
`form.*` captions are the agency’s own Malay words and are printed in Malay whatever language
the reader has chosen.

## Header band

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| HEADER |  | (C.P.8A - Pin. 2023) | heading (takes no value) | The form itself — printed on every copy, nothing goes in it | The edition this page is drawn to. Changing it means re-tracing the form. | `form.formNo` |
| HEADER |  | No. Siri | text | nothing feeds this yet | The employer’s own running number for the statements it issues. Nothing in this system holds it, and the rule is printed empty. | `form.serialNo` |
| HEADER |  | No. Majikan E | text | The employer’s company record (employer.eNumber) |  | `form.employerTin` |
| HEADER |  | MALAYSIA | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `form.masthead1` |
| HEADER |  | CUKAI PENDAPATAN | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `form.masthead2` |
| HEADER |  | PENYATA SARAAN DARIPADA PENGGAJIAN | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `form.masthead3` |
| HEADER |  | BAGI TAHUN BERAKHIR 31 DISEMBER | year | Filled in by this system (year) | The one masthead line that is COMPLETED rather than printed: the year of assessment is appended. The blank copy leaves it open. | `form.masthead4` |
| HEADER |  | Penyata Gaji Pekerja SWASTA | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `form.privateStatement` |
| HEADER |  | EA | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `form.ea` |
| HEADER |  | No. Pengenalan Cukai (TIN) Pekerja | text | The employee’s staff record (employee.taxNo) |  | `form.employeeTin` |
| HEADER |  | LHDNM Negeri | text | The employer’s company record (employer.lhdnState) |  | `form.lhdnState` |
| HEADER |  | BORANG EA INI PERLU DISEDIAKAN UNTUK DISERAHKAN KEPADA PEKERJA BAGI TUJUAN CUKAI PENDAPATAN | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `form.banner` |

## A — Butiran Pekerja (employee particulars)

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| A | A | BUTIRAN PEKERJA | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.sectionAEmployeeParticulars` |
| A | 1 | Nama Penuh Pekerja / Pesara (Encik/Cik/Puan) | text | The employee’s staff record (employee.name) |  | `payroll.ea.name` |
| A | 2 | Jawatan | text | The employee’s staff record (employee.jobTitle) | The title on the assignment in force at the END of the employment’s year — a leaver has one, an open assignment is not required. | `payroll.ea.jobTitle` |
| A | 3 | No. Kakitangan / No. Gaji | text | The employee’s staff record (employee.employeeNo) |  | `payroll.ea.employeeNo` |
| A | 4 | No. K.P. Baru | text | The employee’s staff record (employee.ic) |  | `payroll.ea.icNo` |
| A | 5 | No. Pasport | text | The employee’s staff record (employee.passport) |  | `payroll.ea.passportNo` |
| A | 6 | No. KWSP | text | The employee’s staff record (employee.epfNo) |  | `payroll.ea.epfNo` |
| A | 7 | No. PERKESO | text | The employee’s staff record (employee.socsoNo) |  | `payroll.ea.socsoNo` |
| A | 8 | Bilangan anak yang layak untuk pelepasan cukai | whole number | The employee’s staff record (employee.children) | A COUNT OF CHILDREN, never the s.48-weighted figure. LHDN’s own English for this box is “Number of children qualified for tax relief”, and it is printed among the identifiers in the left column with no RM heading; bilangan is a count. Read per child-relief mode (r353, restored by r364): on ‘auto_table’ the KEYED grid’s head count, which sums full and half shares as WHOLE children, so a 50%-shared child counts as ONE; otherwise employee_statutory_my.num_children. An ‘auto_table’ employee with no grid keyed prints 0 — that grid declares relief for nobody. An employee with no statutory row at all gets the agency’s empty rule, because unrecorded is not zero. ⚠️ r359 printed LHDN’s weighted C here for one day (9 for an employee with two children, and a fraction where a claim is shared 50/50). C is a variable in the MONTHLY tax formula: the agency’s own calculation slip prints a child grid of 1 plus 1 on page 1 and “C = Number of eligible children 9.00” on page 6 of the same document. NOT to be confused with D.6, which is the RINGGIT and is weighted. It reads the employee’s position TODAY, not as at the year printed on the form; no per-year snapshot of this count exists. | `payroll.ea.childrenTaxRelief` |
| A | 9 | Jika bekerja tidak genap setahun, nyatakan: | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.partYearNote` |
| A | 9(a) | Tarikh mula bekerja | date | The employee’s staff record (employee.hiredOn) | Printed ONLY when the date falls inside the selected year of assessment — the form asks for it only when the employment did not run the whole year. | `payroll.ea.startedOn` |
| A | 9(b) | Tarikh berhenti kerja | date | The employee’s staff record (employee.terminatedOn) | Same condition as 9(a), decided on its own date: a leaver hired years ago shows a leaving date and an empty commencement rule. | `payroll.ea.leftOn` |

## B — Pendapatan Penggajian, Manfaat dan Tempat Kediaman (employment income, benefits, accommodation)

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| B | B | PENDAPATAN PENGGAJIAN, MANFAAT DAN TEMPAT KEDIAMAN | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.sectionBEmploymentIncome` |
| B |  | (Tidak Termasuk Elaun / Perkuisit / Pemberian / Manfaat Yang Dikecualikan Cukai) | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.sectionBExcluding` |
| B |  | RM | heading (takes no value) | The form itself — printed on every copy, nothing goes in it | Printed ONCE, over the right-hand money column, for the whole form. | `form.rm` |
| B | 1(a) | Gaji kasar, upah atau gaji cuti (termasuk gaji lebih masa) | amount (RM) | Payroll, and amendable under “Amend EA figures” (partB.grossSalary) |  | `payroll.ea.grossSalary` |
| B | 1(b) | Fi (termasuk fi pengarah), komisen atau bonus | amount (RM) | Payroll, and amendable under “Amend EA figures” (partB.bonus, partB.directorFee) | ONE agency box over TWO of our figures: bonus (payroll) plus director’s fees / commission (amendment only). Prints only when the sum is non-zero, because half of it has no payroll source. | `payroll.ea.feesCommissionBonus` |
| B | 1(c) | Tip kasar, perkuisit, penerimaan sagu hati atau elaun-elaun lain | amount (RM) | Payroll, and amendable under “Amend EA figures” (partB.allowances, partB.tipsPerquisites) | ONE agency box over TWO of our figures: allowances (payroll) plus tips / perquisites (amendment only). Same rule as 1(b). r353 — the allowances half is the TAXABLE allowance only: Section B is headed “Excluding Tax Exempt Allowances / Perquisites / Gifts / Benefits”, so the exempt portion is subtracted here and reported in Section F instead of twice. | `payroll.ea.tipsPerquisitesOther` |
| B | 1(c) | Perihal pembayaran: | free text the form asks for | nothing feeds this yet | The description rule inside 1(c). Writing a description we do not hold would be inventing a fact about somebody’s pay, so the rule stays empty. | `payroll.ea.paymentDetail` |
| B | 1(d) | Cukai pendapatan yang dibayar oleh majikan bagi pihak pekerja | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.taxBorneByEmployer) |  | `payroll.ea.taxBorneByEmployer` |
| B | 1(e) | Manfaat Skim Opsyen Saham Pekerja (ESOS) | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.esos) |  | `payroll.ea.esos` |
| B | 1(f) | Ganjaran bagi tempoh dari _ hingga _ | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.gratuity) |  | `payroll.ea.gratuity` |
| B | 1(f) | dari | date | nothing feeds this yet | The first of 1(f)’s two period rules. The gratuity period is not a fact this system holds. | `payroll.ea.periodFrom` |
| B | 1(f) | hingga | date | nothing feeds this yet | The second of 1(f)’s two period rules. | `payroll.ea.periodTo` |
| B | 2 | Butiran bayaran tunggakan dan lain-lain bagi tahun-tahun terdahulu dalam tahun semasa | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.arrears) |  | `payroll.ea.arrears` |
| B | 2 | Jenis pendapatan | free text the form asks for | nothing feeds this yet | Item 2’s sub-line, with a rule at (a) and (b). Both carry a description and no money; the amount belongs to item 2 itself. | `payroll.ea.incomeType` |
| B | 3 | Manfaat berupa barangan | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.benefitsInKind) |  | `payroll.ea.benefitsInKind` |
| B | 3 | Nyatakan: | free text the form asks for | nothing feeds this yet | The description rule inside item 3. | `payroll.ea.stateWhat` |
| B | 4 | Nilai tempat kediaman | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.livingAccommodation) |  | `payroll.ea.livingAccommodation` |
| B | 4 | Alamat: | free text the form asks for | nothing feeds this yet | The address rule inside item 4. | `payroll.ea.addressCue` |
| B | 5 | Bayaran balik daripada Kumpulan Wang Simpanan / Pencen yang tidak diluluskan | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.unapprovedFundRefund) |  | `payroll.ea.unapprovedFundRefund` |
| B | 6 | Pampasan kerana kehilangan pekerjaan | amount (RM) | Only “Amend EA figures” — no payroll source exists (partB.compensation) |  | `payroll.ea.compensation` |

## C — Pencen dan Lain-lain (pension and others)

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| C | C | PENCEN DAN LAIN-LAIN | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.sectionCPensionOther` |
| C | 1 | Pencen | amount (RM) | Only “Amend EA figures” — no payroll source exists (partC.pension) | This product pays no pensions, so there is no payroll source and never has been. | `payroll.ea.pension` |
| C | 2 | Anuiti atau bayaran berkala yang lain | amount (RM) | Only “Amend EA figures” — no payroll source exists (partC.annuity) |  | `payroll.ea.annuity` |
| C |  | JUMLAH | amount (RM) | Added up from the boxes above it on this form (partB.gross, partC.total) | The form’s ONLY total, closed with a double rule. It totals B and C together — the two subtotals our own earlier layout had are not on the agency’s page. | `payroll.ea.formTotal` |

## D — Jumlah Potongan (total deductions)

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| D | D | JUMLAH POTONGAN | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.sectionDTotalDeductions` |
| D | 1 | Potongan cukai bulanan (PCB) yang dibayar kepada LHDNM | amount (RM) | Payroll, and amendable under “Amend EA figures” (partD.mtd) |  | `payroll.ea.monthlyTaxDeduction` |
| D | 2 | Arahan potongan CP38 yang dibayar kepada LHDNM | amount (RM) | Payroll, and amendable under “Amend EA figures” (partD.cp38) |  | `payroll.ea.cp38Deductions` |
| D | 3 | Zakat yang dibayar melalui potongan gaji | amount (RM) | Payroll, and amendable under “Amend EA figures” (partD.zakat) |  | `payroll.ea.zakatViaSalary` |
| D | 4 | Derma / hadiah / sumbangan diluluskan yang dibayar melalui potongan gaji | amount (RM) | Only “Amend EA figures” — no payroll source exists (partD.donations) |  | `payroll.ea.donations` |
| D | 5 | Jumlah tuntutan potongan oleh pekerja melalui Borang TP1 berkaitan: | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.tp1ClaimHeading` |
| D | 5(a) | Pelepasan | amount (RM) | Payroll, and amendable under “Amend EA figures” (partD.tp1Relief) | Derived from the year’s APPROVED TP1 declarations. Prints its own “RM” and rule at mid-page; the right-hand column stays empty on this line. | `payroll.ea.tp1Relief` |
| D | 5(b) | Zakat selain yang dibayar melalui potongan gaji bulanan | amount (RM) | Only “Amend EA figures” — no payroll source exists (partD.zakatOther) | Mid-page “RM” and rule, like 5(a). | `payroll.ea.zakatOther` |
| D | 6 | Jumlah pelepasan bagi anak yang layak | amount (RM) | Payroll — the year’s payslips (partD.childRelief) | r351 — DERIVED since the reporter asked for the ringgit rather than an empty rule. The annual, s.48-weighted child relief the payroll kernel actually allowed, read off the year’s LAST slip carrying a pcbMeta.reliefs snapshot (so a disabled child in higher education shows RM16,000, not RM2,000). Still amendable. A year whose slips carry no snapshot — written before 169e3c24, or a flat-rate non-resident — leaves the box empty rather than printing 0.00. NOT to be confused with A.8, which is the COUNT and stays a count — r364 restored that after r359 briefly made A.8 this figure divided by RM2,000. A.8 × RM2,000 is NOT D.6 and never was: the s.48 weighting is exactly why two children can be worth RM18,000. The two boxes answer different questions, so neither is evidence about the other and A.8 prints even when this box has nothing to state. | `payroll.ea.childRelief` |

## E — Caruman … Kumpulan Wang Simpanan / Pencen yang Diluluskan dan PERKESO (contributions)

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| E | E | CARUMAN YANG DIBAYAR OLEH PEKERJA KEPADA KUMPULAN WANG SIMPANAN / PENCEN YANG DILULUSKAN DAN PERKESO | heading (takes no value) | The form itself — printed on every copy, nothing goes in it |  | `payroll.ea.sectionEContributions` |
| E | 1 | Nama Kumpulan Wang | text | Payroll — the year’s payslips (partE.fundName) |  | `payroll.ea.fundName` |
| E | 1 | Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja) | amount (RM) | Payroll, and amendable under “Amend EA figures” (partE.epf) | The employee’s share only. The same caption is printed again on item 2, after the agency’s “2. PERKESO:”. | `payroll.ea.contributionAmount` |
| E | 2 | 2. PERKESO : | amount (RM) | Payroll, and amendable under “Amend EA figures” (partE.socso, partE.eis, partE.skbbk) | The item number and the word PERKESO are the agency’s and are printed in Malay in both languages; the caption after them is item 1’s. ⚠️ r367 — ONE BOX OVER THREE OF OUR FIGURES, which is the same shape B.1(b) and B.1(c) already have. It used to state the SOCSO leg alone. The caption is the ORGANISATION’s, not one scheme’s: LHDN’s own BM original (docs/forms/ea-cp8a-pin-2023-official-bm.xlsx, sharedStrings 82 and 64) heads the section “… DAN PERKESO” and writes the box as “PERKESO : Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja)”, and LHDN scopes contributions to that organisation to two Acts on Form TP1 item C14 — the Employees’ Social Security Act 1969 [Act 4] and the Employment Insurance System Act 2017 [Act 800] (docs/forms/tp1-2026-form-en.pdf and its explanatory notes). EIS is Act 800; SKBBK is Act 4 as amended (Akta A1788), employee-only, mandatory from 1 Jun 2026 on the same PERKESO schedule, and it POSTDATES Pin. 2023 — so the caption’s silence about it is a dating fact, not an exclusion. The three legs stay SEPARATE data so HR can amend the right one; the renderer adds them. | `form.perkeso` |

## F — Jumlah Elaun … yang Dikecualikan Cukai (total exempt allowances)

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| F | F | JUMLAH ELAUN / PERKUISIT / PEMBERIAN / MANFAAT YANG DIKECUALIKAN CUKAI | amount (RM) | Payroll — the year’s payslips (partB.exemptAllowances) | ONE line: the section title IS the item. The figure is the year’s tax-exempt allowance portions. ⚠️ r353 — this note used to end “which are a PART of 1(c) and not an addition to it”, and that was the defect: 1(c) is EXCLUDING tax-exempt money by its own section heading, so F and 1(c) are disjoint and F is the only box on the form that reports this ringgit. | `payroll.ea.sectionFExemptAllowances` |

## The foot — signing date and officer box

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| FOOT |  | Tarikh: | date | Filled in by this system (formDate) | ⚠️ r367 — THIS BOX IS FILLED NOW, REVERSING r219, WHOSE NOTE READ: “The date the employer SIGNS the statement. Theirs to write, not ours to invent, so the rule prints empty on a filled form too.” The reporter has told us what to write. The rule is MIN(today in Kuala Lumpur, 28 February of the year after the EA year), computed by localization/my/reports.ts eaFormDate() rather than in the renderer, so no EA test reads a clock. ⚠️ THE RULE IS THE REPORTER’S BUSINESS RULE, NOT THE AGENCY’S: no published LHDN date for this box is sourced in this repository or in the committed agency files, and it is deliberately not presented as a statutory deadline (test/statutory-forms-page.test.ts leaves Form E’s deadline unset for the same reason). 28 February is literal — a leap year does not move it. The BLANK form still prints the agency’s empty rule. | `form.date` |
| FOOT |  | Nama Pegawai | text | The employer’s company record (employer.officerName) | “Name Pegawai” is the SPECIMEN’S own spelling — Malay would be “Nama”. Reproduced as the agency’s form has it and deliberately not corrected. | `form.officerName` |
| FOOT |  | Jawatan | text | The employer’s company record (employer.officerPosition) |  | `form.officerPosition` |
| FOOT |  | Nama dan Alamat Majikan | text | The employer’s company record (employer.name, employer.address) | TWO rules: the employer’s name on the first, the address folded onto the second. The form has no third rule. | `form.employerNameAddress` |
| FOOT |  | No. Telefon Majikan | text | The employer’s company record (employer.phone) |  | `form.employerPhone` |

## Below the form — our own strip

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| BELOW |  | — | sentence | Filled in by this system (overrides) | Printed only when HR has amended at least one figure on this statement. | `payroll.ea.amendedNote` |

## Not drawn on the page

| Section | Box | Official wording (C.P.8A Pin. 2023) | Value | Fed by | Notes | Caption |
| --- | --- | --- | --- | --- | --- | --- |
| META |  | — | sentence | Filled in by this system (year) | The PDF’s document title — the browser tab and the file’s properties. Nothing is drawn from it. | `payroll.ea.title` |

## Boxes nothing feeds yet

7 of the 69 entries in this register take a value the agency asks
for and this system holds nothing for. Each prints the blank form’s own rule and nothing on it —
never a placeholder, never `0.00`, never a plausible guess. They are listed again here because
they are the shortest answer to “what is still missing from the EA?”.

- **HEADER** — No. Siri — The employer’s own running number for the statements it issues. Nothing in this system holds it, and the rule is printed empty.
- **B 1(c)** — Perihal pembayaran: — The description rule inside 1(c). Writing a description we do not hold would be inventing a fact about somebody’s pay, so the rule stays empty.
- **B 1(f)** — dari — The first of 1(f)’s two period rules. The gratuity period is not a fact this system holds.
- **B 1(f)** — hingga — The second of 1(f)’s two period rules.
- **B 2** — Jenis pendapatan — Item 2’s sub-line, with a rule at (a) and (b). Both carry a description and no money; the amount belongs to item 2 itself.
- **B 3** — Nyatakan: — The description rule inside item 3.
- **B 4** — Alamat: — The address rule inside item 4.
