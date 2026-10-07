/**
 * e0cd4583 — draw a CP39 monthly PCB statement with pdf-lib (pure JS, no WASM/native, so no Next
 * bundler friction). Mirrors lib/borang-a-pdf.ts and lib/borang-8a-pdf.ts, which are the house pattern
 * for a form we draw from scratch.
 *
 * ── TWO PAGE SIZES IN ONE DOCUMENT, WHICH IS THE FIRST THING TO KNOW ──────────────────────────────
 * PAGE ONE IS A4 LANDSCAPE and is drawn to the Borang CP39 (Pin.2015) arrangement. The employee
 * schedule from page two onward stays A4 PORTRAIT, because ten columns of names and identity card
 * numbers were laid out for portrait and re-tiling them is a different change with a different risk.
 * pdf-lib takes a size per `addPage`, so the two live side by side in one file: `drawCover` calls
 * `addPage([CW, CH])` and `drawTableSheet` calls `addPage([W, H])`. Neither `paginateCp39` nor
 * `CP39_TABLE_COLUMNS` knows or cares.
 *
 * ── c99e8358 — THE MASTHEAD AND THE A / B / C PANELS ARE NOW DRAWN, AND WHERE THE WORDS CAME FROM ──
 * `docs/forms/cp39-pin-2015-specimen.png` is a FILLED Borang CP39 (Pin.2015) — legible masthead,
 * legible A / B / C instruction panels — and `docs/forms/cp39-pin-2015-transcription.txt` is a
 * hand-made, word-for-word transcription of it together with the measured proportions of every rule on
 * the page. `CP39_NOTE_A`, `CP39_NOTE_B*` and `CP39_NOTE_C` below are that transcription, verbatim,
 * including the specimen's own doubled "CP38 - CP38 -" in A.6 and its own "borang in lieu of CP39".
 * `docs/forms/cp39-our-output-2026-08-21.png` is what this file produced BEFORE the redraw, kept so the
 * change stays legible to the next reader.
 *
 * ⚠️ THE PRINCIPLE THAT KEPT THEM UNDRAWN UNTIL NOW STILL GOVERNS EVERY WORD ON THIS PAGE, AND IT IS
 * THE REASON THIS PARAGRAPH IS NOT DELETED. Printing a government office address from memory is
 * inventing a fact about a filing; writing out a statutory instruction panel from memory is
 * fabricating the content of a government document. Neither is any less true than it was. What changed
 * is only the input: there is now a transcription in this repository to copy FROM, so nothing here is
 * remembered. Anything this page cannot read off that transcription still does not get printed —
 * a Sabah or Sarawak address that is not on the specimen, a receipt number, a signature.
 *
 * ⚠️ AND THE SPECIMEN IS STILL NOT LHDN ARTWORK. It is another payroll system's rendering of the
 * agency's page — the same provenance as the earlier CP39 reference "Income Tax CP39.pdf"
 * (Producer = Developer Express Inc. DXperience v23.2.5), and the same as the EPF and SOCSO "agency
 * reference" attachments HANDOFF records. `public/forms/` holds only the agency artwork in
 * `MY_OFFICIAL_ARTWORK` (CP22; CP22A since r413; CP21 since r415), and the specimen deliberately does NOT go there. So `my.cp39` declares
 * `agency-layout` — drawn to the agency's own arrangement, on our own paper, with no agency artwork on
 * disk, exactly like `my.borang-8a` and `my.borang-a` — and it may NEVER declare `official`. The page
 * says so on its own face in the strip along the bottom.
 *
 * The signature stays a rule to write on: manual by definition. The payment instrument (cheque / bank
 * draft / postal order number and its branch) is manual in the same sense — never payroll-derived — but
 * it IS typeable on the review screen, because this page doubles as the payment cover document and the
 * operator normally has the instrument in front of them when they print it. Typed, it prints; untyped,
 * it prints the same ruled line the specimen prints there.
 *
 * ── PAGINATION IS THE PART THAT GOES WRONG SILENTLY ───────────────────────────────────────────────
 * Page 1 is the cover — employer, period, payment panel and preparer. The employee table starts on
 * page 2 and runs as many sheets as it needs, each closing with its own JUMLAH and the last also
 * carrying JUMLAH BESAR. The arithmetic lives in `paginateCp39`, where it is asserted at one, two and
 * three sheets without a PDF in sight.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { cp39ScheduleScopeNote, money, type Cp39Form, type Cp39FormPage } from './cp39-form';

/** A4 portrait, in points — the employee schedule sheets, page two onward. */
const W = 595.28;
const H = 841.89;
const M = 28;
const RIGHT = W - M;

/** A4 LANDSCAPE, in points — page one only. */
const CW = 841.89;
const CH = 595.28;

/**
 * ── THE COVER'S GEOMETRY, MEASURED OFF THE SPECIMEN RATHER THAN GUESSED ───────────────────────────
 *
 * Every number here is a rule that was measured on `docs/forms/cp39-pin-2015-specimen.png` (1212 x 829)
 * and mapped onto A4 landscape by holding the LEFT and RIGHT margins at 36pt and scaling the interior:
 * `36 + (px - 52) * (770 / 1122)` horizontally, `30 + (px - 42) * 0.715` vertically.
 *
 * MEASURED, NOT READ OFF THE PROSE. The rules were found by scanning the PNG for columns that are dark
 * down the whole band, which is how the top band's verticals came out at 4.4 / 31.3 / 73.2 / 96.9 % and
 * the three-panel band's at 4.3 / 38.9 / 48.3 / 70.4 / 96.9 %. The percentages first written into
 * `docs/forms/cp39-pin-2015-transcription.txt` for the two masthead boxes were EYEBALLED and were wrong
 * by up to 20 points of page width; they have since been corrected from this scan. If the two ever
 * disagree again, the SCAN wins and the prose is what needs fixing.
 *
 * `x` is points from the LEFT edge. `yTop` is points from the TOP edge, because that is how the
 * specimen reads and how a form is described; `at()` inside the renderer turns one into a pdf-lib y.
 *
 * Exported so test/cp39-form.test.ts measures WHAT IS ACTUALLY DRAWN — the r193 Borang 8A lesson,
 * brought up to the cover: a caption is not clipped by pdf-lib, so one wider than its panel prints
 * straight into its neighbour and the page still renders, still returns 200 and still downloads.
 */
export const CP39_COVER = {
  W: CW,
  H: CH,
  x: {
    left: 36,
    /** KETUA PENGARAH … box: the left masthead block. */
    mastheadRight: 260.4,
    /** UNTUK KEGUNAAN PEJABAT box. */
    officeLeft: 609,
    right: 806,
    /** BUTIR-BUTIR MAJIKAN | BUTIR-BUTIR PEMBAYARAN. */
    panel1Right: 323.6,
    /** BUTIR-BUTIR PEMBAYARAN | PEGAWAI YANG MENYEDIAKAN MAKLUMAT. */
    panel2Right: 585.7,
    /** Inside the payment panel: its own row-label column. */
    payLabelRight: 402.5,
    /** Inside the payment panel: PCB column | CP 38 column. THE TRANSPOSITION LINE. */
    payPcbRight: 496.5,
    /** Inside the payment panel's instrument block: the Amaun/Nombor/Cawangan/Tarikh label column. */
    payInstrLabelRight: 462.2,
    /** The notes band: A fills the left half, B and C stack in the right half. */
    noteBLeft: 415.5,
    /** The [ A ] letter cell and the [ BORANG CP 39 ] title cell beside it. */
    noteLetterRight: 53.8,
    noteTitleRight: 173.9,
  },
  yTop: {
    photocopy: 22,
    boxTop: 30,
    officeBottom: 120.1,
    mastheadBottom: 123,
    bandTop: 139.4,
    /** Bottom of the three panel HEADINGS row. */
    bandHeadBottom: 153.7,
    /** Bottom of the PCB / CP 38 column-heading row inside the payment panel. */
    payHeadBottom: 168.7,
    payJumlahBottom: 182.3,
    payBilanganBottom: 200.9,
    bandBottom: 276.7,
    noteHeadTop: 286,
    noteHeadBottom: 303.1,
    noteBodyTop: 314.6,
    /**
     * C SITS ~20pt HIGHER THAN ON THE SPECIMEN, AND THAT IS THE ONE DELIBERATE DEPARTURE.
     * The specimen runs C down to the foot of the sheet because it has nothing else to print there;
     * ours carries the provenance strip below it, which the agency's page has no reason to have. The
     * alternative was to overprint C's second line with it, which is how a caption ends up underneath
     * its own box.
     */
    noteCHeadTop: 492,
    noteCHeadBottom: 509.1,
    /** The provenance strip: small type along the foot of the cover. */
    footTop: 545,
  },
} as const;

/** Type size of a panel heading on the cover (BUTIR-BUTIR MAJIKAN, UNTUK KEGUNAAN PEJABAT, …). */
export const CP39_COVER_HEADING_SIZE = 7.5;
/** Type size of a printed value on the cover — an employer name, an amount, a preparer's IC. */
export const CP39_COVER_VALUE_SIZE = 7.5;
/** Type size of the A / B / C instruction panels. */
export const CP39_NOTE_SIZE = 6.5;
/** Baseline-to-baseline distance in the A / B / C panels. */
export const CP39_NOTE_LEADING = 10.2;

/**
 * One printed line of an instruction panel, as a list of runs on ONE baseline.
 *
 * `dx` is the offset from the panel's own left edge, so a numbered item is `[{dx:0,'1.'},{dx:14,…}]`
 * and its continuation is `[{dx:14,…}]` — the marker keeps its own gutter and the prose hangs beside it,
 * which is how the specimen sets them. Only the LAST run wraps; its continuation lines resume at that
 * run's own `dx`. A.6 needs three runs on one baseline, which is why this is a list rather than a
 * (marker, text) pair.
 */
export type Cp39NoteRun = { dx: number; text: string };
export type Cp39NoteLine = readonly Cp39NoteRun[];

/**
 * ── PANEL A, VERBATIM ─────────────────────────────────────────────────────────────────────────────
 *
 * Copied word for word from `docs/forms/cp39-pin-2015-transcription.txt`, which was transcribed by hand
 * from the specimen. NOT paraphrased, NOT translated, NOT corrected: "borang in lieu of CP39" in 3.2(ii)
 * and the doubled "CP38 - CP38 -" in item 6 are the specimen's own and stay. Malay on every locale, like
 * every other drawn statutory form here — the viewer's language never changes a Malaysian tax form.
 *
 * The only thing that is not preserved is RUNS OF SPACES: the specimen aligns "PCB" and "CP38" in item 6
 * with padding, and this file aligns them with `dx` instead, which is the same alignment expressed in
 * points rather than in spaces.
 */
export const CP39_NOTE_A_TITLE = 'BORANG CP 39';
export const CP39_NOTE_A: readonly Cp39NoteLine[] = [
  [{ dx: 0, text: '1.' }, { dx: 15, text: 'Borang ini mesti diisi dengan lengkap dan betul.' }],
  [
    { dx: 0, text: '2.' },
    {
      dx: 15,
      text:
        'Majikan digalakkan menghantar maklumat potongan melalui e-PCB/e-Data PCB/disket/cakera ' +
        'padat/pemacu flash mengikut format yang ditentukan oleh LHDN bagi menggantikan Borang CP39.',
    },
  ],
  [{ dx: 0, text: '3.' }, { dx: 15, text: 'No. Cukai Pendapatan:' }],
  [
    { dx: 15, text: '3.1' },
    { dx: 35, text: 'Isikan nombor cukai pendapatan dalam ruangan yang telah disediakan.' },
  ],
  [{ dx: 35, text: 'Contoh: SG 2506203-00(0) boleh diisi sebagai SG 02506203000' }],
  [
    { dx: 15, text: '3.2' },
    {
      dx: 35,
      text:
        'Bagi pekerja yang layak dikenakan PCB tetapi tiada nombor cukai pendapatan, ' +
        'pendaftaran boleh dibuat melalui :',
    },
  ],
  [
    { dx: 45, text: 'i.' },
    {
      dx: 58,
      text: 'majikan atau pekerja boleh mendaftar secara atas talian melalui e-Daftar di www.hasil.gov.my, atau',
    },
  ],
  [
    { dx: 45, text: 'ii.' },
    { dx: 58, text: 'Borang CP22 atau borang in lieu of CP39 dikemukakan ke cawangan LHDNM yang berdekatan.' },
  ],
  [{ dx: 0, text: '4.' }, { dx: 15, text: 'Nama pekerja :' }],
  [
    {
      dx: 15,
      text:
        'Isikan nama penuh pekerja seperti di kad pengenalan/pasport (Jangan senaraikan pekerja yang ' +
        'tidak layak dikenakan potongan bagi bulan berkenaan).',
    },
  ],
  [
    { dx: 0, text: '5.' },
    {
      dx: 15,
      text: 'Nombor Pengenalan : Isikan kedua-dua nombor kad pengenalan baru dan lama (sekiranya ada).',
    },
  ],
  [{ dx: 15, text: 'Contoh: 720403065235 atau A2172122' }],
  [
    { dx: 0, text: '6.' },
    { dx: 15, text: 'Jumlah Potongan Cukai:' },
    { dx: 108, text: 'PCB   -  Isikan amaun cukai mengikut Potongan Cukai Bulanan.' },
  ],
  [{ dx: 108, text: 'CP38 -  CP38 - Isikan amaun potongan cukai mengikut arahan Borang CP38 (jika ada).' }],
];

/** ── PANEL B, VERBATIM — items 1 to 5, then the two addresses side by side, then item 8. ─────────── */
export const CP39_NOTE_B_TITLE = 'PEMBAYARAN';
export const CP39_NOTE_B: readonly Cp39NoteLine[] = [
  [
    { dx: 0, text: '1.' },
    {
      dx: 15,
      text:
        'Bayaran dan Borang CP39 yang telah lengkap diisi mestilah sampai ke Pusat Bayaran LHDN ' +
        'selewat-lewatnya pada hari kelima belas bulan berikutnya.',
    },
  ],
  [{ dx: 15, text: 'Contoh:  PCB/CP38 bagi bulan Januari 2015, tarikh akhirnya ialah pada 15 Februari 2015.' }],
  [
    { dx: 0, text: '2.' },
    {
      dx: 15,
      text:
        'Sediakan borang CP39 beserta cek/bank draf/kiriman wang/wang pos (instrumen bayaran) yang ' +
        'berasingan untuk bulan atau tahun berlainan.',
    },
  ],
  [
    { dx: 0, text: '3.' },
    { dx: 15, text: 'Pastikan jumlah potongan PCB/CP38 adalah betul dan sama dengan nilai instrumen bayaran.' },
  ],
  [
    { dx: 0, text: '4.' },
    {
      dx: 15,
      text:
        'Instrumen bayaran hendaklah dibayar kepada Ketua Pengarah Hasil Dalam Negeri. Catatkan no. ' +
        'majikan E, Nama Syarikat/Perniagaan dan alamat majikan di belakang instrumen bayaran.',
    },
  ],
  [
    { dx: 0, text: '5.' },
    {
      dx: 15,
      text:
        'Bayaran untuk Cukai Syarikat, Skim Ansurans (CP500), Penyelesaian Cukai (Pemberhentian Kerja) ' +
        'dan Cukai Keuntungan Harta Tanah tidak boleh dibayar bersama dengan bayaran yang menggunakan ' +
        'borang ini.',
    },
  ],
];

/**
 * B.6 and B.7 sit SIDE BY SIDE on the specimen — 6 in the left half of panel B, 7 in the right half,
 * each with its four address lines beneath it — and B.8 runs full width under both. Modelling them as
 * two lists rather than as eight sequential lines is what keeps that arrangement.
 */
export const CP39_NOTE_B_SABAH: readonly Cp39NoteLine[] = [
  [{ dx: 0, text: '6.' }, { dx: 15, text: 'Untuk bayaran bagi Negeri Sabah, sila alamatkan ke:' }],
  [{ dx: 15, text: 'Cawangan Pungutan Kota Kinabalu' }],
  [{ dx: 15, text: 'Wisma Hasil' }],
  [{ dx: 15, text: 'Jalan Tunku Abdul Rahman' }],
  [{ dx: 15, text: '88600 Kota Kinabalu, Sabah' }],
];
export const CP39_NOTE_B_SARAWAK: readonly Cp39NoteLine[] = [
  [{ dx: 0, text: '7.' }, { dx: 15, text: 'Untuk bayaran bagi Negeri Sarawak, sila alamatkan ke:' }],
  [{ dx: 15, text: 'Cawangan Pungutan Kuching,' }],
  [{ dx: 15, text: 'Aras 1, Wisma Hasil,' }],
  [{ dx: 15, text: 'No. 1, Jalan Padungan,' }],
  [{ dx: 15, text: '93100 Kuching, Sarawak' }],
];
export const CP39_NOTE_B_TAIL: readonly Cp39NoteLine[] = [
  [
    { dx: 0, text: '8.' },
    { dx: 15, text: 'Sila hubungi talian 1-800-88-LHDN (5436) untuk sebarang pertanyaan lanjut.' },
  ],
];

/** ── PANEL C, VERBATIM. ───────────────────────────────────────────────────────────────────────────── */
export const CP39_NOTE_C_TITLE = 'PERINGATAN';
export const CP39_NOTE_C: readonly Cp39NoteLine[] = [
  [
    { dx: 0, text: '1.' },
    { dx: 15, text: 'Jika jumlah instrumen bayaran tidak sama dengan jumlah potongan, bayaran akan ditolak.' },
  ],
  [
    { dx: 0, text: '2.' },
    { dx: 15, text: 'Sekiranya maklumat tidak lengkap dan tidak betul, majikan akan dikenakan kompaun.' },
  ],
];

/** The LHDN payment-centre block in the top-left box, verbatim from the specimen. Bold first two lines. */
export const CP39_MASTHEAD_BOLD = ['KETUA PENGARAH HASIL DALAM NEGERI', 'LEMBAGA HASIL DALAM NEGERI'] as const;
export const CP39_MASTHEAD_ADDRESS = [
  'Pusat Bayaran Kuala Lumpur',
  'Kaunter Bayaran Dan Tingkat 1, Blok 8A',
  'Kompleks Bangunan Kerajaan, Jalan Duta',
  '50600 KUALA LUMPUR',
] as const;
/** The centred title block. First line bold; the last three are the statutory citation, in brackets. */
export const CP39_TITLE_BLOCK = [
  'CUKAI PENDAPATAN MALAYSIA',
  'PENYATA POTONGAN CUKAI OLEH MAJIKAN',
  '[SEKSYEN 107 AKTA CUKAI PENDAPATAN, 1967',
  'KAEDAH CUKAI PENDAPATAN (POTONGAN DARIPADA',
  'SARAAN), 1994]',
] as const;

/** Heading type size. Exported so the geometry test measures what is actually drawn. */
export const CP39_HEADING_SIZE = 6;
/** Body type size for a table row. */
export const CP39_ROW_SIZE = 7.5;

/**
 * The employee table's geometry, measured against the HEADINGS rather than guessed — the r193 Borang 8A
 * lesson: a heading is not clipped, so one wider than its column prints straight into its neighbour.
 *
 * TEN COLUMNS ON A4 PORTRAIT IS THE WHOLE DIFFICULTY. Borang A has seven and still needed its clip
 * allowance widened after somebody rasterised the page and looked at it. The captions are the
 * specimen's own, upper case and centred; where one does not fit our narrower portrait column it is
 * broken over lines that do ("KOD" / "NEGARA", where the specimen sets "KOD NEGARA" on one), and
 * test/cp39-form.test.ts asserts exactly that with pdf-lib's own font metrics — the columns tile the
 * printable width with no overlap, and no heading line is wider than the column it sits in.
 *
 * `x` is the LEFT edge for a left-aligned column and the RIGHT edge for a right-aligned one; `width` is
 * the column's own space in both cases.
 */
export const CP39_TABLE_COLUMNS = [
  { key: 'bil', x: 28, width: 16, align: 'left', head: ['BIL'] },
  { key: 'tin', x: 44, width: 74, align: 'left', head: ['NO. CUKAI', 'PENDAPATAN'] },
  {
    key: 'name',
    x: 118,
    width: 118,
    align: 'left',
    head: ['NAMA PENUH PEKERJA', '(SEPERTI DI KAD PENGENALAN', 'ATAU PASPORT)'],
  },
  { key: 'oldIc', x: 236, width: 50, align: 'left', head: ['NO. K/P LAMA'] },
  { key: 'newIc', x: 286, width: 58, align: 'left', head: ['NO. K/P BARU'] },
  { key: 'employeeNo', x: 344, width: 44, align: 'left', head: ['NO.', 'PEKERJA'] },
  { key: 'passport', x: 388, width: 48, align: 'left', head: ['NO. PASPORT'] },
  { key: 'countryCode', x: 436, width: 29, align: 'left', head: ['KOD', 'NEGARA'] },
  { key: 'pcb', x: 513, width: 48, align: 'right', head: ['PCB (RM)'] },
  { key: 'cp38', x: 567, width: 54, align: 'right', head: ['CP38 (RM)'] },
] as const;

export type Cp39TableColumn = (typeof CP39_TABLE_COLUMNS)[number];

/**
 * A column's own span on the sheet, in points from the left edge.
 *
 * `x` is the LEFT edge of a left-aligned column and the RIGHT edge of a right-aligned one, which is
 * convenient to draw with and useless to rule a table with. Exported so the renderer and the geometry
 * test read the same spans out of the same declaration rather than each re-deriving them.
 */
export const cp39ColumnSpan = (c: Cp39TableColumn): { left: number; right: number } =>
  c.align === 'right' ? { left: c.x - c.width, right: c.x } : { left: c.x, right: c.x + c.width };

/**
 * ── THE TWO-LEVEL HEADINGS, WHICH ARE THE PART A FLAT ROW OF CAPTIONS CANNOT SAY ──────────────────
 *
 * The specimen groups four of the ten columns under two spanning captions: NO. PASPORT and KOD NEGARA
 * both belong to BAGI PEKERJA ASING (they are asked for a FOREIGN employee), and PCB (RM) and CP38 (RM)
 * are the two halves of JUMLAH POTONGAN CUKAI. Drawn flat, "NO. PASPORT" beside "NO. K/P BARU" reads as
 * one more identity column for everybody, which is a different instruction to whoever fills it in.
 *
 * `from`/`to` are column KEYS and the members are the columns between them INCLUSIVE, so a group cannot
 * silently pick up a column that moved: test/cp39-form.test.ts asserts the members are contiguous, that
 * the caption fits the SUM of their widths at pdf-lib's own metrics, and that the group's span is
 * exactly its children's.
 */
export const CP39_TABLE_GROUPS = [
  { text: 'BAGI PEKERJA ASING', from: 'passport', to: 'countryCode' },
  { text: 'JUMLAH POTONGAN CUKAI', from: 'pcb', to: 'cp38' },
] as const;

/** The columns a group spans, in printed order. Empty is impossible — the test pins that too. */
export function cp39GroupColumns(g: (typeof CP39_TABLE_GROUPS)[number]): Cp39TableColumn[] {
  const keys = CP39_TABLE_COLUMNS.map((c) => c.key as string);
  return CP39_TABLE_COLUMNS.slice(keys.indexOf(g.from), keys.indexOf(g.to) + 1) as unknown as Cp39TableColumn[];
}

/**
 * The agency's OWN footer line, verbatim from `docs/forms/cp39-pin-2015-page2-transcription.txt`.
 *
 * Transcribed, never remembered — the same rule the A / B / C panels on the cover are held to. It is a
 * statement about where LHDN publishes the form, and this repository can point at the specimen it was
 * read off; nothing else about the agency gets printed here.
 */
export const CP39_AGENCY_FOOTER = 'Borang CP39 boleh diperolehi di laman web : http://www.hasil.gov.my';

/**
 * ── THE SCHEDULE SHEET'S GEOMETRY ─────────────────────────────────────────────────────────────────
 *
 * Read this beside `docs/forms/cp39-pin-2015-page2-specimen.png`. Like `CP39_COVER`, `yTop` is points
 * from the TOP edge because that is how a form is described and how the specimen reads; `at()` inside
 * the renderer turns one into a pdf-lib y. Exported so test/cp39-form.test.ts measures WHAT IS ACTUALLY
 * DRAWN rather than restating the arithmetic — pdf-lib does not clip, so a caption one point too wide
 * for its cell prints into the cell beside it and the page still renders and still downloads.
 *
 * THE FOOT BAND FOLLOWS THE TABLE, AND STOPS. On the specimen the totals box and the agency's footer
 * line sit immediately under a table that happens to fill the page, so "under the table" and "at the
 * foot of the sheet" are the same place there — and only one of them can stay true here, because our
 * sheet holds 26 rows and a real statement rarely fills one. The box follows the last ruled row, which
 * is what the specimen's own renderer does and what keeps a total beside the figures it totals; `footMax`
 * is the clamp that stops a full sheet's band from ever reaching the provenance strip below it.
 */
export const CP39_SHEET = {
  W,
  H,
  x: {
    left: M,
    /** The table's right edge — the CP38 column's right edge, not the paper's right margin. */
    tableRight: 567,
    /** The totals box's label cell starts on an existing column rule, so it reads as part of the grid. */
    totalsLabelLeft: 388,
    /** The money block: PCB's left edge, and the PCB | CP38 rule inside it. */
    moneyLeft: 465,
    moneySplit: 513,
    right: RIGHT,
  },
  yTop: {
    /** Baseline of the `No. Majikan  E  <number>` / `Muka Surat  <n>` line. */
    header: 36,
    /** The dotted rule the employer number and the page number are written on. */
    headerRule: 39.5,
    /** The table's top border. */
    tableTop: 54,
    /** Bottom of the GROUP heading row — the rule under BAGI PEKERJA ASING / JUMLAH POTONGAN CUKAI. */
    headGroupBottom: 72,
    /** Bottom of the whole heading band: where the first data row starts. */
    headBottom: 106,
    /** The table body may never run past here — 26 rows at `rowH` land exactly on it. */
    bodyLimit: 704,
    /** The lowest the foot band (agency line left, totals box right) may start. */
    footMax: 710,
    /** The hairline above our own provenance strip, and the strip's first baseline. */
    stripRule: 774,
    stripTop: 786,
  },
  /** One data row. 26 of them (`CP39_FORM_ROWS_PER_PAGE`) fill the body without reaching `bodyLimit`. */
  rowH: 23,
  /** One row of the totals box. */
  totalsRowH: 17,
} as const;

/** Type size of a label or a figure in the totals box at the foot of the schedule. */
export const CP39_TOTALS_SIZE = 8;

export async function renderCp39FormPdf(form: Cp39Form): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`CP39 — ${form.employerName} — ${form.deductionMonth} ${form.deductionYear}`);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.42, 0.47);
  const rule = rgb(0.6, 0.6, 0.65);
  const hair = rgb(0.82, 0.82, 0.86);

  /**
   * Helvetica is WinAnsi (Latin-1). Typography is FOLDED rather than dropped: an em dash and a curly
   * apostrophe are U+2014 / U+2019, outside Latin-1, and would otherwise print our own footer as
   * "CP39 ? bukan borang rasmi". A NAME still degrades to '?', the same documented limitation
   * lib/ea-pdf.ts, lib/borang-8a-pdf.ts and lib/borang-a-pdf.ts carry, with a Unicode font embed as the
   * deferred follow-up.
   */
  const fold = (s: string) =>
    (s ?? '')
      .replace(/[–—−]/g, '-')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...');
  const safe = (s: string) => fold(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  /** Wrap to an arbitrary width. An unwrapped sentence runs off the sheet and no check sees it. */
  const wrapAt = (s: string, size: number, maxW: number, f: PDFFont = font): string[] => {
    const out: string[] = [];
    let cur = '';
    for (const w of safe(s).split(/\s+/)) {
      const trial = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && cur) {
        out.push(cur);
        cur = w;
      } else {
        cur = trial;
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  /** Wrap to the SCHEDULE sheet's full printable width. */
  const wrap = (s: string, size: number, maxW = RIGHT - M): string[] => wrapAt(s, size, maxW);

  drawCover();

  // ── Page 2 onward: the employee table ────────────────────────────────────────────────────────────
  for (const pageData of form.pages) {
    drawTableSheet(pageData);
  }

  /**
   * ── PAGE ONE, IN THE OFFICIAL ARRANGEMENT ───────────────────────────────────────────────────────
   *
   * Read this beside `docs/forms/cp39-pin-2015-specimen.png`. Every coordinate comes from `CP39_COVER`,
   * which is measured off that image, and every caption is drawn RELATIVE TO ITS OWN BOX rather than to
   * whatever `y` the previous block left behind — the r205 Borang A lesson, which is the one failure a
   * geometry check written in font metrics cannot see and only a rasterised page shows.
   */
  function drawCover() {
    const page = doc.addPage([CW, CH]);
    const { x: X, yTop: Y } = CP39_COVER;
    /** Points from the top edge → pdf-lib's y. The specimen is described from the top; so is this. */
    const at = (t: number) => CH - t;

    const put = (s: string, x: number, t: number, size: number, f: PDFFont = font, color = ink) =>
      page.drawText(safe(s), { x, y: at(t), size, font: f, color });
    const putR = (s: string, xr: number, t: number, size: number, f: PDFFont = font, color = ink) =>
      page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y: at(t), size, font: f, color });
    const putC = (s: string, cx: number, t: number, size: number, f: PDFFont = font, color = ink) =>
      page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y: at(t), size, font: f, color });
    /** A ruled box, given in top-edge coordinates: (left, top, right, bottom). */
    const box = (x0: number, t0: number, x1: number, t1: number, thickness = 0.8) =>
      page.drawRectangle({
        x: x0,
        y: at(t1),
        width: x1 - x0,
        height: t1 - t0,
        borderColor: rule,
        borderWidth: thickness,
      });
    const hRule = (x0: number, x1: number, t: number, thickness = 0.8, color = rule) =>
      page.drawLine({ start: { x: x0, y: at(t) }, end: { x: x1, y: at(t) }, thickness, color });
    const vRule = (x: number, t0: number, t1: number, thickness = 0.8, color = rule) =>
      page.drawLine({ start: { x, y: at(t0) }, end: { x, y: at(t1) }, thickness, color });
    /** The dotted rule the specimen writes its values on. */
    const dotted = (x0: number, x1: number, t: number) => {
      for (let x = x0; x < x1; x += 3) {
        page.drawLine({ start: { x, y: at(t) }, end: { x: Math.min(x + 1.4, x1), y: at(t) }, thickness: 0.5, color: rule });
      }
    };
    /**
     * SHRINK TO FIT, NEVER CLIP AND NEVER OVERPRINT — r205's Borang A lesson, and it bites HARDER on a
     * landscape form divided into panels than it did on a full-width sheet.
     *
     * pdf-lib does not clip. 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR' is 231pt at 7.5pt and
     * the Nama Syarikat rule is 173pt wide, so an unshrunk legal name prints 58pt straight through the
     * panel divider and lands ON TOP of the PCB figures in BUTIR-BUTIR PEMBAYARAN. Truncating instead
     * would be worse, not better: a clean truncation READS AS THE VALUE. So the size comes down, rounded
     * DOWN to 0.1pt so the drawn string stays inside `maxW`, and clamped at 1pt. The clamp is the one
     * case where it can still exceed its rule — a value needing under 1pt would be invisible, and an
     * overprint gets queried while an invisible value does not. Both halves are deliberate; neither is
     * an invariant the geometry guard can assume.
     */
    const fitSize = (v: string, maxW: number, size: number, f: PDFFont = font) => {
      const w = f.widthOfTextAtSize(v, size);
      if (w <= maxW || w <= 0) return size;
      return Math.max(1, Math.floor((size * maxW * 10) / w) / 10);
    };
    const putFit = (s: string, x: number, maxW: number, t: number, size: number, f: PDFFont = font) => {
      const v = safe(s);
      page.drawText(v, { x, y: at(t), size: fitSize(v, maxW, size, f), font: f, color: ink });
    };
    const putRFit = (s: string, xr: number, maxW: number, t: number, size: number, f: PDFFont = font) => {
      const v = safe(s);
      const sz = fitSize(v, maxW, size, f);
      page.drawText(v, { x: xr - f.widthOfTextAtSize(v, sz), y: at(t), size: sz, font: f, color: ink });
    };
    /**
     * A VALUE, OR THE RULE THE SPECIMEN PRINTS INSTEAD OF ONE (AGENTS rule 28).
     *
     * Never a placeholder, never "0.00" standing in for "we do not know". A figure the form derives is
     * printed; a box that is the operator's to complete by hand gets the dotted rule and nothing else,
     * because an empty rule asserts nothing while a printed zero asserts that the money does not exist.
     */
    const valueOrRule = (v: string, x0: number, x1: number, t: number, size = CP39_COVER_VALUE_SIZE) => {
      dotted(x0, x1, t + 2.5);
      if (v) putFit(v, x0 + 3, x1 - x0 - 3, t, size);
    };

    // ── Top line: the photocopy permission and the form's own name ────────────────────────────────
    put('Borang ini boleh difotokopi', X.left, Y.photocopy, 6.8, font, muted);
    putR('CP39 Pin.2015', X.right, Y.photocopy, 6.8, font, muted);

    // ── Top-left box: the LHDN payment centre ─────────────────────────────────────────────────────
    box(X.left, Y.boxTop, X.mastheadRight, Y.mastheadBottom);
    {
      let t = Y.boxTop + 16;
      for (const l of CP39_MASTHEAD_BOLD) {
        put(l, X.left + 10, t, 8, bold);
        t += 10.5;
      }
      t += 6;
      for (const l of CP39_MASTHEAD_ADDRESS) {
        put(l, X.left + 10, t, 7, font);
        t += 9.5;
      }
    }

    // ── Centre: the title block and its two statutory citations, then the period boxes ────────────
    {
      const cx = (X.mastheadRight + X.officeLeft) / 2;
      let t = Y.boxTop + 14;
      CP39_TITLE_BLOCK.forEach((l, i) => {
        putC(l, cx, t, i === 0 ? 9 : 8, i === 0 ? bold : font);
        t += i === 0 ? 13 : 11;
      });
      // POTONGAN BAGI BULAN [ JANUARI ] TAHUN [ 2026 ] — one line, the two values in their own boxes.
      // Laid out from the CENTRE outward so it stays under the title block whatever the month is called.
      const label1 = 'POTONGAN BAGI BULAN';
      const label2 = 'TAHUN';
      const monthW = 62;
      const yearW = 46;
      const gap = 8;
      const bt = Y.mastheadBottom - 17;
      const bb = Y.mastheadBottom - 1;
      const w1 = bold.widthOfTextAtSize(label1, 9);
      const w2 = bold.widthOfTextAtSize(label2, 9);
      const total = w1 + gap + monthW + gap + w2 + gap + yearW;
      let x = cx - total / 2;
      put(label1, x, bb - 5, 9, bold);
      x += w1 + gap;
      box(x, bt, x + monthW, bb);
      putC(form.deductionMonth, x + monthW / 2, bb - 5, 8, bold);
      x += monthW + gap;
      put(label2, x, bb - 5, 9, bold);
      x += w2 + gap;
      box(x, bt, x + yearW, bb);
      putC(form.deductionYear, x + yearW / 2, bb - 5, 8, bold);
    }

    // ── Top-right box: UNTUK KEGUNAAN PEJABAT ─────────────────────────────────────────────────────
    // Two ruled lines and NOT ONE PRINTED CHARACTER between them. A batch number and a receipt number
    // are the agency's to write; anything we put there would be a fact about a filing we invented.
    box(X.officeLeft, Y.boxTop, X.right, Y.officeBottom);
    putC('UNTUK KEGUNAAN PEJABAT', (X.officeLeft + X.right) / 2, Y.boxTop + 17, 8.5, bold);
    {
      const lx = X.officeLeft + 14;
      const rx0 = X.officeLeft + 78;
      const rx1 = X.right - 14;
      put('No. Kelompok', lx, Y.boxTop + 44, CP39_COVER_VALUE_SIZE, font);
      dotted(rx0, rx1, Y.boxTop + 46.5);
      put('No. Resit', lx, Y.boxTop + 68, CP39_COVER_VALUE_SIZE, font);
      dotted(rx0, rx1, Y.boxTop + 70.5);
    }

    // ── The three-panel band ──────────────────────────────────────────────────────────────────────
    box(X.left, Y.bandTop, X.right, Y.bandBottom);
    hRule(X.left, X.right, Y.bandHeadBottom);
    vRule(X.panel1Right, Y.bandTop, Y.bandBottom);
    vRule(X.panel2Right, Y.bandTop, Y.bandBottom);
    const headBase = Y.bandHeadBottom - 4.5;
    putC('BUTIR-BUTIR MAJIKAN', (X.left + X.panel1Right) / 2, headBase, CP39_COVER_HEADING_SIZE, bold);
    putC('BUTIR-BUTIR PEMBAYARAN', (X.panel1Right + X.panel2Right) / 2, headBase, CP39_COVER_HEADING_SIZE, bold);
    putC(
      'PEGAWAI YANG MENYEDIAKAN MAKLUMAT',
      (X.panel2Right + X.right) / 2,
      headBase,
      CP39_COVER_HEADING_SIZE,
      bold,
    );

    // ── Panel 1: BUTIR-BUTIR MAJIKAN ──────────────────────────────────────────────────────────────
    // Label on the left, value on a dotted rule. "No. Majikan" and the "E" beside it are BOLD on the
    // specimen and the rest of the labels are not; that is the specimen's emphasis, not ours.
    {
      const lx = X.left + 10;
      const vx0 = X.left + 100;
      const vx1 = X.panel1Right - 12;
      put('No. Majikan', lx, 174, CP39_COVER_VALUE_SIZE, bold);
      put('E', lx + 62, 174, CP39_COVER_VALUE_SIZE, bold);
      valueOrRule(form.employerNo, vx0, vx1, 174);

      put('No. Pendaftaran', lx, 190, CP39_COVER_VALUE_SIZE, font);
      put('Perniagaan', lx, 199, CP39_COVER_VALUE_SIZE, font);
      valueOrRule(form.registrationNo, vx0, vx1, 195);

      put('Nama Syarikat/', lx, 213, CP39_COVER_VALUE_SIZE, font);
      put('Perniagaan', lx, 222, CP39_COVER_VALUE_SIZE, font);
      valueOrRule(form.employerName, vx0, vx1, 218);

      put('Alamat Syarikat/', lx, 236, CP39_COVER_VALUE_SIZE, font);
      put('Perniagaan', lx, 245, CP39_COVER_VALUE_SIZE, font);
      // FOUR RULES, ALWAYS — the specimen prints four and a short address leaves the tail of them empty
      // rather than closing the box up. A company with five address lines gets the fifth folded into the
      // fourth rather than a line drawn outside the panel.
      const addr = [...form.employerAddress];
      const printed = addr.length > 4 ? [...addr.slice(0, 3), addr.slice(3).join(', ')] : addr;
      for (let i = 0; i < 4; i += 1) {
        // The LAST rule has to clear the band's own bottom edge — `valueOrRule` draws it 2.5pt below the
        // baseline, so the fourth baseline is 271 and not "whatever the step lands on".
        const t = 238 + i * 11;
        valueOrRule(printed[i] ?? '', vx0, vx1, t, 7);
      }
    }

    // ── Panel 2: BUTIR-BUTIR PEMBAYARAN — THE PART THAT CARRIES MONEY ─────────────────────────────
    //
    // ⚠️ PCB AND CP38 ARE TWO ADJACENT COLUMNS OF NEARLY EQUAL WIDTH CARRYING TWO DIFFERENT AMOUNTS.
    // That is the transposition trap that shipped a wrong KWSP file in an earlier round: swapping the
    // two draws a page that renders, totals correctly and is wrong in a way nobody reading it can see.
    // So each figure is drawn through `payCell`, which takes the COLUMN and the value together, and
    // test/cp39-form.test.ts asserts which amount landed in which column by reading the drawn page's
    // text-positioning operators — not by re-adding the totals object, which cannot tell them apart.
    //
    // Every figure here comes off the SAME `Cp39Form` the schedule sheets and the text export use.
    // Nothing on this panel is recomputed, and there is no second source for any of them.
    {
      const p2 = { l: X.panel1Right, r: X.panel2Right };
      vRule(X.payLabelRight, Y.bandHeadBottom, Y.bandBottom);
      hRule(p2.l, p2.r, Y.payHeadBottom);
      hRule(p2.l, p2.r, Y.payJumlahBottom);
      hRule(p2.l, p2.r, Y.payBilanganBottom);
      vRule(X.payPcbRight, Y.bandHeadBottom, Y.payBilanganBottom);

      const cols = {
        pcb: { x0: X.payLabelRight, x1: X.payPcbRight },
        cp38: { x0: X.payPcbRight, x1: p2.r },
      } as const;
      putC('PCB', (cols.pcb.x0 + cols.pcb.x1) / 2, Y.payHeadBottom - 5, CP39_COVER_HEADING_SIZE, bold);
      putC('CP 38', (cols.cp38.x0 + cols.cp38.x1) / 2, Y.payHeadBottom - 5, CP39_COVER_HEADING_SIZE, bold);

      /**
       * ONE call site per figure, and the COLUMN is an argument rather than a coordinate — which is what
       * makes the transposition assertable at all. The figure is right-aligned in its own cell and
       * shrunk to whatever the cell leaves after the RM, so a very large amount cannot back out of it
       * leftwards into the column beside it.
       */
      const payCell = (which: 'pcb' | 'cp38', t: number, value: string, prefix = '') => {
        const c = cols[which];
        let from = c.x0 + 6;
        if (prefix) {
          put(prefix, from, t, CP39_COVER_VALUE_SIZE, font);
          from += font.widthOfTextAtSize(prefix, CP39_COVER_VALUE_SIZE) + 4;
        }
        putRFit(value, c.x1 - 6, c.x1 - 6 - from, t, CP39_COVER_VALUE_SIZE);
      };

      put('Jumlah Potongan', p2.l + 8, Y.payJumlahBottom - 5, CP39_COVER_VALUE_SIZE, font);
      payCell('pcb', Y.payJumlahBottom - 5, money(form.totalPcb), 'RM');
      payCell('cp38', Y.payJumlahBottom - 5, money(form.totalCp38), 'RM');

      put('Bilangan Pekerja', p2.l + 8, Y.payBilanganBottom - 6, CP39_COVER_VALUE_SIZE, font);
      payCell('pcb', Y.payBilanganBottom - 6, String(form.pcbEmployees));
      payCell('cp38', Y.payBilanganBottom - 6, String(form.cp38Employees));

      // The instrument block: one tall wrapped label against four rows.
      vRule(X.payInstrLabelRight, Y.payBilanganBottom, Y.bandBottom);
      const rows = 4;
      const rowH = (Y.bandBottom - Y.payBilanganBottom) / rows;
      for (let i = 1; i < rows; i += 1) hRule(X.payInstrLabelRight, p2.r, Y.payBilanganBottom + i * rowH);
      {
        const label = ['Butir-butir / Cek /', 'Bank / Deraf /', 'Kiriman Wang /', 'Wang Pos'];
        const cx = (p2.l + X.payLabelRight) / 2;
        const block = label.length * 9;
        let t = Y.payBilanganBottom + (Y.bandBottom - Y.payBilanganBottom - block) / 2 + 7;
        for (const l of label) {
          putC(l, cx, t, 6.6, font);
          t += 9;
        }
      }
      const instr: [string, string, boolean][] = [
        // [label, value, is it ours to print?] — Amaun and Tarikh are derived, so they print. Nombor
        // and Cawangan are the operator's: typed on the review screen when they have the instrument in
        // hand, and otherwise a rule to write on. Never a zero, never a placeholder.
        ['Amaun', money(form.totalAmount), true],
        ['Nombor', form.paymentRef, false],
        ['Cawangan', form.paymentBranch, false],
        ['Tarikh', form.printedOn, true],
      ];
      instr.forEach(([label, value, derived], i) => {
        const t = Y.payBilanganBottom + i * rowH + rowH - 6;
        put(label, X.payLabelRight + 8, t, CP39_COVER_VALUE_SIZE, font);
        let from = X.payInstrLabelRight + 6;
        if (derived) {
          if (label === 'Amaun') {
            put('RM', from, t, CP39_COVER_VALUE_SIZE, font);
            from += font.widthOfTextAtSize('RM', CP39_COVER_VALUE_SIZE) + 4;
          }
          putRFit(value, p2.r - 6, p2.r - 6 - from, t, CP39_COVER_VALUE_SIZE);
        } else if (value) {
          putFit(value, from, p2.r - 6 - from, t, CP39_COVER_VALUE_SIZE);
        } else {
          dotted(from, p2.r - 6, t + 2.5);
        }
      });
    }

    // ── Panel 3: PEGAWAI YANG MENYEDIAKAN MAKLUMAT ────────────────────────────────────────────────
    {
      const lx = X.panel2Right + 10;
      const vx0 = X.panel2Right + 78;
      const vx1 = X.right - 12;
      const fields: [string, string][] = [
        // Tandatangan is manual by definition and gets the rule, never a name.
        ['Tandatangan', ''],
        ['Nama Penuh', form.preparerName],
        ['No. Pengenalan', form.preparerIc],
        ['Jawatan', form.preparerPosition],
        ['No. Telefon', form.preparerPhone],
      ];
      const first = Y.bandHeadBottom + 21;
      const step = (Y.bandBottom - 8 - first) / (fields.length - 1);
      fields.forEach(([label, value], i) => {
        const t = first + i * step;
        put(label, lx, t, CP39_COVER_VALUE_SIZE, font);
        valueOrRule(value, vx0, vx1, t);
      });
    }

    // ── The A / B / C instruction panels ──────────────────────────────────────────────────────────
    /** [ A ][ BORANG CP 39 ] — a narrow letter cell and a wide title cell beside it. */
    const noteHead = (letter: string, title: string, x0: number, t0: number, t1: number) => {
      const lw = X.noteLetterRight - X.left;
      const tw = X.noteTitleRight - X.noteLetterRight;
      box(x0, t0, x0 + lw, t1);
      box(x0 + lw, t0, x0 + lw + tw, t1);
      putC(letter, x0 + lw / 2, t1 - 5.5, 8, bold);
      putC(title, x0 + lw + tw / 2, t1 - 5.5, 8, bold);
    };
    /** Draw one panel's lines and answer the y (from the top) the NEXT line would occupy. */
    const drawNotes = (lines: readonly Cp39NoteLine[], x0: number, width: number, t0: number): number => {
      let t = t0;
      for (const line of lines) {
        for (let i = 0; i < line.length; i += 1) {
          const runIsLast = i === line.length - 1;
          const run = line[i];
          if (!runIsLast) {
            put(run.text, x0 + run.dx, t, CP39_NOTE_SIZE, font);
            continue;
          }
          const wrapped = wrapAt(run.text, CP39_NOTE_SIZE, width - run.dx);
          wrapped.forEach((w, k) => {
            put(w, x0 + run.dx, t + k * CP39_NOTE_LEADING, CP39_NOTE_SIZE, font);
          });
          t += (wrapped.length - 1) * CP39_NOTE_LEADING;
        }
        t += CP39_NOTE_LEADING;
      }
      return t;
    };

    const aWidth = X.noteBLeft - 14 - X.left;
    const bWidth = X.right - X.noteBLeft;
    noteHead('A', CP39_NOTE_A_TITLE, X.left, Y.noteHeadTop, Y.noteHeadBottom);
    drawNotes(CP39_NOTE_A, X.left, aWidth, Y.noteBodyTop);

    noteHead('B', CP39_NOTE_B_TITLE, X.noteBLeft, Y.noteHeadTop, Y.noteHeadBottom);
    {
      let t = drawNotes(CP39_NOTE_B, X.noteBLeft, bWidth, Y.noteBodyTop);
      // 6 and 7 SIDE BY SIDE, exactly as the specimen sets them, and 8 full width beneath both.
      const half = bWidth / 2;
      const left = drawNotes(CP39_NOTE_B_SABAH, X.noteBLeft, half - 8, t);
      const right = drawNotes(CP39_NOTE_B_SARAWAK, X.noteBLeft + half, half, t);
      t = Math.max(left, right);
      drawNotes(CP39_NOTE_B_TAIL, X.noteBLeft, bWidth, t);
    }

    noteHead('C', CP39_NOTE_C_TITLE, X.noteBLeft, Y.noteCHeadTop, Y.noteCHeadBottom);
    drawNotes(CP39_NOTE_C, X.noteBLeft, bWidth, Y.noteCHeadBottom + 11.5);

    // ── The provenance strip along the foot ───────────────────────────────────────────────────────
    // What comes off this screen is drawn to the agency's arrangement and is still printed on our own
    // paper, so it says so — the single claim the statutory-forms fidelity vocabulary exists to keep
    // honest. `cp39ScheduleScopeNote` rides here too: it is a statement about the SCHEDULE's own
    // arithmetic, and it lives in one exported function so this page and the text export cannot drift.
    {
      let t = Y.footTop;
      hRule(X.left, X.right, t - 8, 0.6, hair);
      const strip = [
        `Susun atur mengikut Borang CP39 (Pin.2015), dicetak di atas kertas kami sendiri - bukan borang ` +
          `rasmi LHDN. Bulan potongan ${form.deductionMonth} ${form.deductionYear} - sama dengan bulan ` +
          `gaji, tiada anjakan. LHDN tidak menerima CP39 bercetak: hantar melalui e-PCB / e-Data PCB / e-CP39.`,
        cp39ScheduleScopeNote(form),
      ];
      for (const paragraph of strip) {
        for (const l of wrapAt(paragraph, 6, X.right - X.left)) {
          put(l, X.left, t, 6, font, muted);
          t += 8.4;
        }
      }
    }
  }

  /**
   * ── PAGE TWO ONWARD, AS THE RULED SCHEDULE THE SPECIMEN DRAWS ───────────────────────────────────
   *
   * Read this beside `docs/forms/cp39-pin-2015-page2-specimen.png` — the FILLED official reverse the
   * reporter attached — with `docs/forms/cp39-our-page2-2026-08-22.png` for what this replaced and
   * `docs/forms/cp39-our-page2-2026-08-23.png` for what it now prints. Every coordinate comes from
   * `CP39_SHEET` and every caption is drawn RELATIVE TO ITS OWN CELL rather than to whatever `y` the
   * previous block left behind — the r205 Borang A lesson, which is the one failure a geometry check
   * written in font metrics cannot see and only a rasterised page shows.
   *
   * WHAT CHANGED AND WHY, IN ONE PLACE:
   *  • The schedule is RULED. Every cell is bordered and the four foreign-worker / tax-deduction columns
   *    sit under their two spanning headings, because a flat row of captions says something different:
   *    "NO. PASPORT" beside "NO. K/P BARU" reads as one more identity column for everybody.
   *  • The page number counts the WHOLE DOCUMENT, cover included. `Muka surat {sheet}/{of}` counted
   *    SCHEDULE sheets only, so the first schedule sheet printed "1/1" where the official form calls
   *    that same sheet "Muka Surat 2" — which is exactly the "page 2 is a continuation, not a new
   *    document" the reporter came back with, arrived at from the other end.
   *  • AMAUN (PCB + CP38) is GONE from here. It belongs to BUTIR-BUTIR PEMBAYARAN on the cover, which
   *    prints it; the figure itself is not lost, because the specimen's JUMLAH BESAR spans both money
   *    columns and IS that same total. Two copies of one figure are two figures that can disagree.
   *
   * The sheet stays A4 PORTRAIT. Only the cover is landscape.
   */
  function drawTableSheet(pageData: Cp39FormPage) {
    const page: PDFPage = doc.addPage([W, H]);
    const { x: X, yTop: Y } = CP39_SHEET;
    /** Points from the top edge → pdf-lib's y. The specimen is described from the top; so is this. */
    const at = (t: number) => H - t;
    const last = pageData.sheet === pageData.of;
    /**
     * THE DOCUMENT's page number, which is the defect this round exists to fix. The cover is page 1, so
     * the first schedule sheet is 2 — what the specimen prints in this very box.
     */
    const muka = pageData.sheet + 1;

    const put = (s: string, x: number, t: number, size: number, f: PDFFont = font, color = ink) =>
      page.drawText(safe(s), { x, y: at(t), size, font: f, color });
    const putR = (s: string, xr: number, t: number, size: number, f: PDFFont = font, color = ink) =>
      page.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y: at(t), size, font: f, color });
    const putC = (s: string, cx: number, t: number, size: number, f: PDFFont = font, color = ink) =>
      page.drawText(safe(s), { x: cx - f.widthOfTextAtSize(safe(s), size) / 2, y: at(t), size, font: f, color });
    const hRule = (x0: number, x1: number, t: number, thickness = 0.7, color = rule) =>
      page.drawLine({ start: { x: x0, y: at(t) }, end: { x: x1, y: at(t) }, thickness, color });
    const vRule = (x: number, t0: number, t1: number, thickness = 0.7, color = rule) =>
      page.drawLine({ start: { x, y: at(t0) }, end: { x, y: at(t1) }, thickness, color });
    /** A ruled box, given in top-edge coordinates: (left, top, right, bottom). */
    const box = (x0: number, t0: number, x1: number, t1: number, thickness = 0.7) =>
      page.drawRectangle({
        x: x0,
        y: at(t1),
        width: x1 - x0,
        height: t1 - t0,
        borderColor: rule,
        borderWidth: thickness,
      });
    /** The dotted rule the specimen writes the employer number and the page number on. */
    const dotted = (x0: number, x1: number, t: number) => {
      for (let x = x0; x < x1; x += 3) {
        page.drawLine({
          start: { x, y: at(t) },
          end: { x: Math.min(x + 1.4, x1), y: at(t) },
          thickness: 0.5,
          color: rule,
        });
      }
    };
    /**
     * SHRINK TO FIT, NEVER CLIP — r205's Borang A lesson, brought here by 7ee14bbc point 5.
     *
     * This used to be a `textClip` that dropped characters off the end until the string fitted, which is
     * the worst failure a renderer of a signed filing can have: a clean truncation READS AS THE VALUE.
     * 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR' becomes a shorter company; `941128-03-5179`
     * becomes `941128-03-517`, a different identity card number that is still twelve-ish digits long and
     * still looks entirely normal beside somebody's tax reference. An overprint gets queried; a
     * truncation does not. Clipping is also exactly how you HIDE an overprint from a geometry check.
     *
     * So the size is shrunk instead, rounded DOWN to 0.1pt so the drawn string stays inside `maxW`, and
     * clamped at 1pt — below which a value would be invisible, and invisible is silent loss too. At that
     * clamp, and only there, the string can still exceed its column.
     * Applied to EVERY text column, not just the name: a cut tax reference number is the same defect.
     */
    const fitSize = (v: string, maxW: number, size: number, f: PDFFont = font) => {
      const w = f.widthOfTextAtSize(v, size);
      if (w <= maxW || w <= 0) return size;
      return Math.max(1, Math.floor((size * maxW * 10) / w) / 10);
    };
    const putFit = (s: string, x: number, maxW: number, t: number, size: number, f: PDFFont = font) => {
      const v = safe(s);
      page.drawText(v, { x, y: at(t), size: fitSize(v, maxW, size, f), font: f, color: ink });
    };
    const putRFit = (s: string, xr: number, maxW: number, t: number, size: number, f: PDFFont = font) => {
      const v = safe(s);
      const sz = fitSize(v, maxW, size, f);
      page.drawText(v, { x: xr - f.widthOfTextAtSize(v, sz), y: at(t), size: sz, font: f, color: ink });
    };
    /** A stack of centred caption lines, vertically centred in its own CELL rather than at a running y. */
    const captionBlock = (lines: readonly string[], x0: number, x1: number, t0: number, t1: number) => {
      const leading = CP39_HEADING_SIZE + 2.2;
      let t = (t0 + t1) / 2 - (lines.length * leading) / 2 + leading - 1.6;
      for (const l of lines) {
        putC(l, (x0 + x1) / 2, t, CP39_HEADING_SIZE, bold);
        t += leading;
      }
    };

    // ── The sheet header: the employer number left, the DOCUMENT page number right ─────────────────
    // The employer and the period repeat on EVERY sheet. A loose page of a statutory schedule with no
    // employer number on it cannot be filed back with the rest of the bundle.
    put('No. Majikan', X.left, Y.header, 9, bold);
    put('E', X.left + 62, Y.header, 9, bold);
    dotted(X.left + 76, X.left + 246, Y.headerRule);
    putFit(form.employerNo || '', X.left + 80, 162, Y.header, 8.5);
    putR('Muka Surat', X.right - 96, Y.header, 9, bold);
    dotted(X.right - 90, X.right, Y.headerRule);
    putR(String(muka), X.right - 4, Y.header, 9);
    // The period and the legal name are ours, not the specimen's — it has no box for them and a sheet
    // that names only an employer number is a sheet you cannot match to a month.
    putFit(
      `${form.employerName || '-'}  ·  POTONGAN BAGI BULAN ${form.deductionMonth} ${form.deductionYear}`,
      X.left,
      X.right - X.left - 120,
      Y.tableTop - 5,
      7,
      font,
    );

    // ── The table ─────────────────────────────────────────────────────────────────────────────────
    const spans = CP39_TABLE_COLUMNS.map((c) => ({ c, ...cp39ColumnSpan(c) }));
    const span = (key: string) => spans.find((s) => s.c.key === key)!;
    const groups = CP39_TABLE_GROUPS.map((g) => {
      const members = cp39GroupColumns(g).map((c) => c.key as string);
      return { g, members, left: span(g.from).left, right: span(g.to).right };
    });
    const grouped = new Set(groups.flatMap((g) => g.members));
    /**
     * A row NEVER shrinks below legibility and NEVER runs off the sheet. `CP39_FORM_ROWS_PER_PAGE` rows
     * fit at the declared height with room to spare; a caller passing a bigger `perPage` gets tighter
     * rows rather than a table drawn over the totals box.
     */
    const rowCount = pageData.rows.length;
    const rowH = rowCount > 0 ? Math.min(CP39_SHEET.rowH, (Y.bodyLimit - Y.headBottom) / rowCount) : CP39_SHEET.rowH;
    const bodyBottom = Y.headBottom + rowCount * rowH;

    box(X.left, Y.tableTop, X.tableRight, bodyBottom, 1);
    // Every column rule runs the full height of the table EXCEPT the one INSIDE a group, which starts
    // below the group's own caption — that is what makes the caption read as spanning its two columns.
    for (const s of spans) {
      if (s.left === X.left) continue;
      const insideGroup = groups.some((g) => s.left > g.left && s.left < g.right);
      vRule(s.left, insideGroup ? Y.headGroupBottom : Y.tableTop, bodyBottom);
    }
    for (const g of groups) hRule(g.left, g.right, Y.headGroupBottom);
    hRule(X.left, X.tableRight, Y.headBottom, 1);
    // EVERY row is ruled, not merely separated by a hairline: the specimen's schedule is a table of
    // bordered cells, and a hairline reads as a list with lines under it.
    for (let i = 1; i < rowCount; i += 1) hRule(X.left, X.tableRight, Y.headBottom + i * rowH, 0.5);

    // ── Column headings: two levels, every caption centred in its OWN cell ─────────────────────────
    for (const s of spans) {
      const top = grouped.has(s.c.key) ? Y.headGroupBottom : Y.tableTop;
      captionBlock(s.c.head, s.left, s.right, top, Y.headBottom);
    }
    for (const g of groups) captionBlock([g.g.text], g.left, g.right, Y.tableTop, Y.headGroupBottom);

    // ── Rows ──────────────────────────────────────────────────────────────────────────────────────
    // Bil runs across the WHOLE statement, not per sheet: it is the numbering read down the schedule.
    let bil = form.pages.slice(0, pageData.sheet - 1).reduce((a, p) => a + p.rows.length, 0);
    const PAD = 4;
    pageData.rows.forEach((r, i) => {
      bil += 1;
      const t = Y.headBottom + (i + 0.5) * rowH + CP39_ROW_SIZE * 0.36;
      const left = (key: string, v: string) => {
        const s = span(key);
        putFit(v, s.left + PAD, s.right - s.left - PAD * 2, t, CP39_ROW_SIZE);
      };
      const right = (key: string, v: string) => {
        const s = span(key);
        putRFit(v, s.right - PAD, s.right - s.left - PAD * 2, t, CP39_ROW_SIZE);
      };
      left('bil', String(bil));
      left('tin', r.tin);
      left('name', r.name);
      left('oldIc', r.oldIc);
      // r409 (item 79f3f64d) — DIGITS ONLY, AS LHDN WRITES IT. 7ee14bbc added dashes here; LHDN's own CP39
      // instructions print the No. K/P Baru as twelve digits, so the row model (`cp39IcForForm`, applied in
      // `cp39FormFrom`) now hands this renderer the digits and nothing re-dashes them on the way to the
      // page. `formatMyIc` stays on the review SCREEN, where a person reads the number.
      left('newIc', r.newIc);
      left('employeeNo', r.employeeNo);
      left('passport', r.passport);
      left('countryCode', r.countryCode);
      right('pcb', money(r.pcb));
      right('cp38', money(r.cp38));
    });
    if (rowCount === 0) {
      put('Tiada pekerja bagi bulan ini / no employees for this month', X.left, bodyBottom + 14, 8, font, muted);
    }

    // ── The foot: the agency's own line at the left, the totals box at the right ───────────────────
    // Both follow the last ruled row, as they do on the specimen, and stop at `footMax` so a full sheet
    // can never push them into the provenance strip.
    const footTop = Math.min(bodyBottom + (rowCount === 0 ? 26 : 6), Y.footMax);
    put(CP39_AGENCY_FOOTER, X.left, footTop + 11, 6.8);

    /**
     * JUMLAH is THIS SHEET's total, split across the two money columns. JUMLAH BESAR is the whole
     * statement's and SPANS BOTH, which is why the AMAUN line that used to sit under this box is gone:
     * that box is the same figure, in the place the form puts it.
     *
     * JUMLAH BESAR still prints on the LAST sheet only. Repeating it is how a multi-page statement gets
     * filed with a page total mistaken for the grand total.
     */
    const jumlahBottom = footTop + CP39_SHEET.totalsRowH;
    const boxBottom = last ? jumlahBottom + CP39_SHEET.totalsRowH : jumlahBottom;
    const midline = (t0: number, t1: number) => (t0 + t1) / 2 + CP39_TOTALS_SIZE * 0.36;
    box(X.totalsLabelLeft, footTop, X.tableRight, boxBottom, 1);
    vRule(X.moneyLeft, footTop, jumlahBottom, 1);
    vRule(X.moneySplit, footTop, jumlahBottom, 1);
    putC('JUMLAH', (X.totalsLabelLeft + X.moneyLeft) / 2, midline(footTop, jumlahBottom), CP39_TOTALS_SIZE, bold);
    putRFit(money(pageData.pagePcb), X.moneySplit - PAD, X.moneySplit - X.moneyLeft - PAD * 2,
      midline(footTop, jumlahBottom), CP39_TOTALS_SIZE, bold);
    putRFit(money(pageData.pageCp38), X.tableRight - PAD, X.tableRight - X.moneySplit - PAD * 2,
      midline(footTop, jumlahBottom), CP39_TOTALS_SIZE, bold);
    if (last) {
      hRule(X.totalsLabelLeft, X.tableRight, jumlahBottom, 1);
      vRule(X.moneyLeft, jumlahBottom, boxBottom, 1);
      putC('JUMLAH BESAR', (X.totalsLabelLeft + X.moneyLeft) / 2, midline(jumlahBottom, boxBottom),
        CP39_TOTALS_SIZE, bold);
      putRFit(money(form.totalAmount), X.tableRight - PAD, X.tableRight - X.moneyLeft - PAD * 2,
        midline(jumlahBottom, boxBottom), CP39_TOTALS_SIZE, bold);
    }

    // ── e4b541c6 / c99e8358: THE TWO COLUMNS, AND THE HALF OF THE OLD NOTE THAT IS STILL TRUE ──────
    // Migration 0450 gave `employee_statutory_my` its own `old_ic_number` and
    // `passport_issuing_country_code`, so both columns now PRINT whatever is on the staff record — the
    // old sentence here ("there is no such field") became a false statement on a tax document and had to
    // go. What did NOT change is the reason Kod Negara is a column of its own: the nationality text
    // beside it is a demonym from the tenant's own option list, "Malaysian" is not "MY", and deriving
    // one from the other would put a wrong statutory code beside somebody's tax reference.
    hRule(X.left, X.right, Y.stripRule, 0.7, hair);
    let strip = Y.stripTop;
    for (const l of wrap(
      'No. K/P Lama dan Kod Negara dicetak daripada rekod pekerja apabila ada, dan dibiarkan kosong ' +
        'apabila tiada - kosong bermakna tiada dalam rekod, bukan tiada dalam sistem. Kod Negara mesti ' +
        'dipilih sebagai kod dua huruf dan tidak pernah diterbitkan daripada teks kewarganegaraan. ' +
        'Helaian jadual ini susun atur kami sendiri - bukan borang rasmi LHDN.',
      6.8,
    )) {
      put(l, X.left, strip, 6.8, font, muted);
      strip += 9;
    }
  }

  return doc.save();
}
