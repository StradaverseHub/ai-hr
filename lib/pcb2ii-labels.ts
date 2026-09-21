/**
 * 72b100cd — the PCB 2(II) captions, in the two languages LHDN publishes the form in.
 *
 * ⚠️ THESE ARE NOT UI STRINGS AND THEY DO NOT LIVE IN messages/*.json. They are the wording PRINTED ON A
 * STATUTORY FORM, transcribed from the specimens attached to the ticket (PCB2II_Pin2012_2, English and BM).
 * The six-locale message catalogue answers "what does this screen say to a Tamil-speaking user"; this
 * answers "what does LHDN's form say", and the two must never be confused — a helpful Vietnamese
 * translation of a Malaysian tax form is not a Malaysian tax form.
 *
 * ⚠️ THE STREAM LABEL GENUINELY DIFFERS, AND IT IS NOT A TRANSLATION SLIP. The English specimen heads the
 * first Amount sub-column **MTD** (Monthly Tax Deduction); the Bahasa Malaysia specimen heads the same
 * column **PCB** (Potongan Cukai Bulanan). Same figure, same source, two official names. Anyone
 * "tidying" these into one label is changing what the form says.
 *
 * The form is published in ENGLISH and BAHASA MALAYSIA only. There is no third language here on purpose.
 */
export type Pcb2iiLang = 'en' | 'ms';

export type Pcb2iiLabels = {
  formCode: string;
  title: string;
  dateLabel: string;
  /** "To:" / "Kepada:" — the BM specimen does not say "To:". */
  toLabel: string;
  toLine1: string;
  toLine2: string;
  branch: string;
  salutation: string;
  yearLabel: string;
  employeeName: string;
  icOrPassport: string;
  employeeTaxNo: string;
  staffNo: string;
  employerNo: string;
  referred: string;
  section2: string;
  colMonth: string;
  colAmount: string;
  colReceiptNo: string;
  colReceiptDate: string;
  /** MTD in English, PCB in Bahasa Malaysia — see the header. */
  streamMtd: string;
  streamCp38: string;
  months: readonly string[];
  total: string;
  section3: string;
  colIncomeType: string;
  colMonth3: string;
  colYear3: string;
  colMtdAmount: string;
  colReceiptNo3: string;
  colReceiptDate3: string;
  thanks: string;
  officerName: string;
  designation: string;
  phone: string;
  employerNameAddress: string;
};

const EN: Pcb2iiLabels = {
  formCode: 'PCB 2(II)-Pin. 2012',
  title: 'STATEMENT OF PAYMENT BY EMPLOYER',
  dateLabel: 'Tarikh:',
  toLabel: 'To:',
  toLine1: 'Chief Executive Officer/Director General Inland Revenue',
  toLine2: 'Inland Revenue Board Of Malaysia',
  branch: 'Branch',
  salutation: 'Sir,',
  yearLabel: 'Tax Deduction Made During The Year',
  employeeName: 'Name Of Employee',
  icOrPassport: 'New Identity Card No./Passport No.',
  employeeTaxNo: 'Employee Income Tax No.',
  staffNo: 'Staff No.',
  employerNo: "Employer's No. (E)",
  referred: 'The above matter is hereby referred.',
  section2: '2. Deductions that have been made to the above employee in the current year are as followed:',
  colMonth: 'Year',
  colAmount: 'Amount (RM)',
  colReceiptNo: 'Receipt No./Bank Slip No./Transaction No.',
  colReceiptDate: 'Receipt Date/Transaction Date',
  streamMtd: 'MTD',
  streamCp38: 'CP38',
  months: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  total: 'Total',
  section3:
    '3. Deductions that have been made to the above employee for the preceeding year income in the current year are as followed:',
  colIncomeType: 'Type Of Income',
  colMonth3: 'Month',
  colYear3: 'Year',
  colMtdAmount: 'MTD Amount (RM)',
  colReceiptNo3: 'Receipt No./ Bank Slip No./ Transaction No.',
  colReceiptDate3: 'Receipt Date/ Transaction Date',
  thanks: 'Thank you.',
  officerName: 'Name Of Officer',
  designation: 'Designation',
  phone: 'Telephone No.',
  employerNameAddress: 'Name And Address Of Employer',
};

const MS: Pcb2iiLabels = {
  formCode: 'PCB 2(II)-Pin. 2012',
  title: 'PENYATA BAYARAN CUKAI OLEH MAJIKAN',
  dateLabel: 'Tarikh:',
  toLabel: 'Kepada:',
  toLine1: 'Ketua Pegawai Eksekutif/Ketua Pengarah Hasil Dalam Negeri',
  toLine2: 'Lembaga Hasil Dalam Negeri Malaysia',
  branch: 'Cawangan',
  salutation: 'Tuan,',
  yearLabel: 'Potongan Cukai Yang Dibuat Dalam Tahun',
  employeeName: 'Nama Pekerja',
  icOrPassport: 'No. Kad Pengenalan/No. Passpot',
  employeeTaxNo: 'No. Cukai Pendapatan Pekerja',
  staffNo: 'No. Pekerja',
  employerNo: 'No. Majikan (E)',
  referred: 'Dengan hormatnya saya merujuk kepada perkara di atas.',
  section2: '2. Potongan-potongan yang telah dibuat bagi pekerja di atas dalam tahun semasa adalah seperti berikut:',
  colMonth: 'Bulan',
  colAmount: 'Amaun (RM)',
  colReceiptNo: 'No. Resit/No. Slip Bank/No. Transaksi',
  colReceiptDate: 'Tarikh Resit/Tarikh Transaksi',
  streamMtd: 'PCB',
  streamCp38: 'CP38',
  months: [
    'Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun',
    'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember',
  ],
  total: 'Jumlah',
  section3:
    '3. Potongan-potongan yang telah dibuat bagi pendapatan pekerja untuk tahun terdahulu dalam tahun semasa adalah seperti berikut:',
  colIncomeType: 'Jenis Pendapatan',
  colMonth3: 'Bulan',
  colYear3: 'Tahun',
  colMtdAmount: 'Amaun PCB (RM)',
  colReceiptNo3: 'No. Resit/ No. Slip Bank/ No. Transaksi',
  colReceiptDate3: 'Tarikh Resit/ Tarikh Transaksi',
  thanks: 'Sekian. Terima kasih.',
  officerName: 'Nama pegawai',
  designation: 'Jawatan',
  phone: 'No. Telefon',
  employerNameAddress: 'Nama Dan Alamat Majikan',
};

export function pcb2iiLabels(lang: Pcb2iiLang): Pcb2iiLabels {
  return lang === 'ms' ? MS : EN;
}
