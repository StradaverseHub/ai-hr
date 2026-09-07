/**
 * Employee import — the FILE UPLOAD step (r78 · feedback "Employee Profile Import CSV Function").
 *
 * The reported gap ("only a template download, no upload") was half right. The check step
 * (validateImportAction → validateEmployeeImport) and the create step (commitImportAction →
 * commitEmployeeImport) already worked and are covered by test/slice0.test.ts. What did not exist was
 * a way to GET a file into them: employee-import.tsx offered a <textarea> and nothing else, so an HR
 * admin had to open their spreadsheet in a text editor and paste its contents.
 *
 * This change adds step 1 only — lib/import-file.ts, File → CSV text — and hands that text to the
 * unchanged validate/commit path.
 *
 * ─── WHAT IS PROVEN HERE vs WHAT IS NOT ────────────────────────────────────────────────────────────
 * PROVEN by execution:
 *   · readImportFile against REAL `File` objects: acceptance, rejection, decoding (§1).
 *   · the text it returns feeds parseCsvRecords → validateEmployeeImport → commitEmployeeImport and
 *     creates employees, with rejected rows carrying reasons (§4, against the DB harness).
 *   · the exact CSV the Download-template button emits round-trips back in through the reader (§2).
 *   · every error the reader can raise resolves to a real message in all six locales (§3) — this is
 *     hand-verification of the dynamic-key hole in test/i18n-coverage.test.ts check C, which only
 *     resolves LITERAL t('…') keys and so cannot see t(importFileMessageKey(e)).
 * NOT PROVEN — reasoned from source only (§5 asserts the wiring statically; this repo has no DOM or
 * interaction runner, so "user picks a file → onChange fires → contents load → preview appears" is
 * NOT exercised anywhere):
 *   · that the <input type="file"> onChange actually fires loadFile in a browser;
 *   · that the drop zone's drag/drop handlers work;
 *   · that the preview renders after an auto-validate.
 * §5 is a source guard, not a behavioural one. If this screen misbehaves, that is the gap.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCsvRecords } from '../lib/csv';
import { IMPORT_COLUMNS } from '../lib/import-schema';
import { buildTemplateCsv, employeeTemplate } from '../lib/import-template';
import {
  IMPORT_FILE_ACCEPT,
  IMPORT_FILE_MESSAGE_KEYS,
  ImportFileError,
  MAX_IMPORT_CSV_BYTES,
  importFileMessageKey,
  isCsvFileName,
  readImportFile,
} from '../lib/import-file';
import { validateEmployeeImport, commitEmployeeImport } from '../core/import';
import { listEmployees } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** A file exactly as the browser hands one over from an <input type="file"> / a drop. */
const csvFile = (text: string | Uint8Array, name = 'employees.csv') =>
  new File([text as BlobPart], name, { type: 'text/csv' });

const HEADER =
  'full_name,email,department,hired_on,ic_number,basic_salary,monthly_allowance,bank_name,bank_account_no,tax_category';

// ── §1 the reader itself ───────────────────────────────────────────────────────────────────────────
describe('§1 readImportFile — File → CSV text', () => {
  it('returns the file contents verbatim, and they parse to the records the importer consumes', async () => {
    const text = `${HEADER}\nNadia Yusof,nadia@demo.test,Finance,2026-06-01,910505051234,5200,400,Maybank,5566778899,2\n`;
    const out = await readImportFile(csvFile(text));

    expect(out.text).toBe(text); // byte-for-byte what a human would have pasted
    expect(out.name).toBe('employees.csv');
    expect(out.format).toBe('csv');

    const { headers, records } = parseCsvRecords(out.text);
    for (const col of IMPORT_COLUMNS.required) expect(headers).toContain(col);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      full_name: 'Nadia Yusof',
      email: 'nadia@demo.test',
      department: 'Finance',
      hired_on: '2026-06-01',
      ic_number: '910505051234',
      basic_salary: '5200',
    });
  });

  it("strips Excel's UTF-8 BOM, so full_name is not reported as a missing required column", async () => {
    // Excel's "CSV UTF-8 (Comma delimited)" export prefixes EF BB BF. Left in place, the first header
    // normalises to "﻿full_name" and the importer rejects the whole file for a missing
    // required column — the single most likely way a real HR upload fails.
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(`${HEADER}\nBom Test,bom@demo.test,Finance,2026-06-01,910505051234,5200,0,,,1\n`),
    ]);
    const out = await readImportFile(csvFile(bytes));
    expect(out.text.charCodeAt(0)).not.toBe(0xfeff);

    const { headers, records } = parseCsvRecords(out.text);
    expect(headers[0]).toBe('full_name');
    expect(records[0].full_name).toBe('Bom Test');
    const missing = IMPORT_COLUMNS.required.filter((c) => !headers.includes(c));
    expect(missing).toEqual([]);
  });

  it('handles Windows CRLF line endings', async () => {
    const text = `${HEADER}\r\nCrlf One,crlf1@demo.test,Finance,2026-06-01,910505051234,5200,0,,,1\r\nCrlf Two,crlf2@demo.test,Finance,2026-06-01,880808082345,4200,0,,,1\r\n`;
    const { records } = parseCsvRecords((await readImportFile(csvFile(text))).text);
    expect(records.map((r) => r.email)).toEqual(['crlf1@demo.test', 'crlf2@demo.test']);
  });

  it('rejects anything that is not an import file, rather than feeding binary to the parser', async () => {
    // d8471481 widened the reader to spreadsheets, so .xlsx / .xls moved OUT of this list — their
    // own handling (including a .xlsx that is not really a workbook) is covered in
    // test/employee-import-xlsx.test.ts. Everything else is still refused on the extension.
    for (const name of ['employees.txt', 'employees', 'employees.csv.pdf', 'employees.numbers']) {
      await expect(readImportFile(csvFile('anything', name)), name).rejects.toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
      });
    }
    // A file NAMED .xlsx that is NOT a workbook is a case worth stating precisely, because SheetJS
    // does not reject it: `XLSX.read` falls back to parsing arbitrary bytes as delimited text, so a
    // mis-named text file DECODES rather than throwing. That is safe, and this asserts why — the
    // decoded rows carry none of the required columns, so `analyze()` reports them missing and the
    // preview offers nothing to import. Nothing is created either way; the difference is only which
    // message the admin sees.
    const misnamed = await readImportFile(csvFile('not a workbook', 'employees.xlsx'));
    expect(misnamed.format).toBe('xlsx');
    const decoded = parseCsvRecords(misnamed.text);
    const stillMissing = IMPORT_COLUMNS.required.filter((c) => !decoded.headers.includes(c));
    expect(stillMissing).toEqual([...IMPORT_COLUMNS.required]);
  });

  it('accepts .csv case-insensitively (Windows loves EMPLOYEES.CSV)', async () => {
    expect(isCsvFileName('EMPLOYEES.CSV')).toBe(true);
    expect(isCsvFileName('Employees.Csv')).toBe(true);
    // `isCsvFileName` still answers only the CSV question — it is the spreadsheet formats that
    // `importFileFormat` distinguishes.
    expect(isCsvFileName('employees.xlsx')).toBe(false);
    await expect(readImportFile(csvFile(`${HEADER}\n`, 'EMPLOYEES.CSV'))).resolves.toMatchObject({
      format: 'csv',
    });
  });

  it('rejects a file over the server-action body ceiling before decoding it', async () => {
    const big = csvFile('x'.repeat(MAX_IMPORT_CSV_BYTES + 1));
    await expect(readImportFile(big)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    // What is asserted is the rejection. That it happens off file.size (so a huge file is never
    // decoded into memory) is a property of the source, not of this test.
    expect(big.size).toBeGreaterThan(MAX_IMPORT_CSV_BYTES);
    // Just under the ceiling still goes through.
    const header = `${HEADER}\n`;
    const filler = 'Just Under,under@demo.test,Finance,2026-06-01,910505051234,5200,0,,,1\n';
    const justUnder = csvFile(header + filler.repeat(Math.floor((MAX_IMPORT_CSV_BYTES - header.length) / filler.length)));
    expect(justUnder.size).toBeLessThanOrEqual(MAX_IMPORT_CSV_BYTES);
    await expect(readImportFile(justUnder)).resolves.toMatchObject({ format: 'csv' });
  });

  it('rejects an empty or whitespace-only file', async () => {
    await expect(readImportFile(csvFile(''))).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    await expect(readImportFile(csvFile('  \r\n \n'))).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('the accept attribute advertises exactly what the reader will take', () => {
    // d8471481 widened reader and accept TOGETHER, which is the property worth pinning: an accept
    // list that promises a format the reader refuses is a picker that silently does nothing.
    for (const ext of ['.csv', '.xlsx', '.xls']) expect(IMPORT_FILE_ACCEPT).toContain(ext);
  });
});

// ── §2 download-template → upload round trip ───────────────────────────────────────────────────────
describe('§2 the downloaded template uploads back in unchanged', () => {
  it('buildTemplateCsv(employeeTemplate) → File → readImportFile → parseCsvRecords keeps the contract', async () => {
    // The exact bytes the "Download template" button writes. Fill-in-and-upload is the whole
    // workflow the reporter asked for, so the two ends are asserted against each other.
    const templateCsv = buildTemplateCsv(employeeTemplate);
    const out = await readImportFile(csvFile(templateCsv, 'employee-import-template.csv'));
    const { headers, records } = parseCsvRecords(out.text);
    expect(headers).toEqual(employeeTemplate.columns.map((c) => c.key));
    for (const col of IMPORT_COLUMNS.required) expect(headers).toContain(col);
    expect(records.length).toBe(employeeTemplate.sampleRows.length);
  });
});

// ── §3 every reader error has a real message, in all six locales ───────────────────────────────────
describe('§3 error → translated message', () => {
  it('maps every ImportFileError code, and degrades an unexpected throw to fileReadError', () => {
    expect(importFileMessageKey(new ImportFileError('UNSUPPORTED_FILE_TYPE'))).toBe('unsupportedFileType');
    expect(importFileMessageKey(new ImportFileError('FILE_TOO_LARGE'))).toBe('fileTooLarge');
    expect(importFileMessageKey(new ImportFileError('EMPTY_FILE'))).toBe('emptyFile');
    expect(importFileMessageKey(new ImportFileError('FILE_READ_FAILED'))).toBe('fileReadError');
    // A raw browser error must never reach an HR admin as-is.
    expect(importFileMessageKey(new TypeError('NetworkError when attempting to fetch resource'))).toBe(
      'fileReadError',
    );
    expect(importFileMessageKey(undefined)).toBe('fileReadError');
  });

  for (const locale of LOCALES) {
    it(`${locale}.json defines every people.import key the upload UI uses`, () => {
      const imp = JSON.parse(read(`/messages/${locale}.json`)).people.import as Record<string, string>;
      const keys = [
        // the upload UI itself
        'uploadFile',
        'dropHere',
        'uploadHint',
        'reading',
        'fileLoaded',
        'pasteToggle',
        // every key reachable via the COMPUTED t(importFileMessageKey(e)) call, which
        // i18n-coverage check C cannot see
        ...Object.values(IMPORT_FILE_MESSAGE_KEYS),
      ];
      for (const k of keys) {
        expect(imp, `${locale}: people.import.${k} must exist`).toHaveProperty(k);
        expect(String(imp[k]).trim(), `${locale}: people.import.${k} must not be blank`).not.toBe('');
      }
      // fileLoaded interpolates the file name.
      expect(imp.fileLoaded).toContain('{name}');
    });
  }
});

// ── §4 the file's text drives the real check + create path ─────────────────────────────────────────
describe('§4 uploaded file → validate → commit (DB)', () => {
  let b: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  /** The full journey the upload button now performs: File → text → records. Nothing between the
   *  reader and the engine is stubbed, so this crosses the seam the change actually introduces. */
  const recordsFromFile = async (rows: string[]) => {
    const out = await readImportFile(csvFile(`${HEADER}\n${rows.join('\n')}\n`));
    return parseCsvRecords(out.text).records;
  };

  it('previews EVERY row — the rejected ones with their reason, not just the good ones', async () => {
    const u = randomUUID().slice(0, 8);
    const records = await recordsFromFile([
      `Good One,good_${u}@acme.test,Finance,2026-06-01,900101011234,5200,400,Maybank,5566778899,2`,
      `Bad Email,not-an-email,Finance,2026-06-01,910101012345,5000,0,,,1`,
      `Unknown Dept,dept_${u}@acme.test,Marketing,2026-06-01,920101013456,5000,0,,,1`,
    ]);
    const preview = await validateEmployeeImport(adminCtx(b), { companyId: b.companyId, records });

    // total counts the file's rows; rows[] carries all three, so the preview cannot hide a rejection.
    expect(preview.total).toBe(3);
    expect(preview.rows).toHaveLength(3);
    expect(preview.validCount).toBe(1);
    expect(preview.rows.filter((r) => !r.ok)).toHaveLength(2);
    // Each rejection states WHY — this is what the screen prints in the Result column.
    expect(preview.rows[1].errors.join(' ')).toMatch(/email/i);
    expect(preview.rows[2].errors.join(' ')).toMatch(/department/i);
    for (const r of preview.rows.filter((x) => !x.ok)) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('names the missing required columns when the uploaded file has the wrong header row', async () => {
    // e.g. someone uploads a file that is not the template at all.
    const out = await readImportFile(csvFile('name,e-mail\nSomeone,someone@acme.test\n'));
    const preview = await validateEmployeeImport(adminCtx(b), {
      companyId: b.companyId,
      records: parseCsvRecords(out.text).records,
    });
    expect(preview.missingColumns).toEqual([...IMPORT_COLUMNS.required]);
    expect(preview.validCount).toBe(0);
  });

  it('commits the valid rows from the uploaded file and skips the rejected ones', async () => {
    const u = randomUUID().slice(0, 8);
    const records = await recordsFromFile([
      `Nadia Yusof,nadia_${u}@acme.test,Finance,2026-06-01,910505051234,5200,400,Maybank,5566778899,2`,
      `Ravi Chandran,ravi_${u}@acme.test,Operations,2026-06-01,880808082345,9800,600,CIMB,1122334455,3`,
      `Broken,not-an-email,Finance,2026-06-01,950909093456,4100,0,,,1`,
    ]);
    const before = (await listEmployees(adminCtx(b))).length;
    const result = await commitEmployeeImport(adminCtx(b), { companyId: b.companyId, records });

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    const after = await listEmployees(adminCtx(b));
    expect(after.length).toBe(before + 2);
    expect(after.some((e) => e.email === `nadia_${u}@acme.test`)).toBe(true);
    expect(after.some((e) => e.email === 'not-an-email')).toBe(false);
  });

  it('a file and the same text pasted produce identical previews (one path, two front doors)', async () => {
    const u = randomUUID().slice(0, 8);
    const text = `${HEADER}\nPath Parity,parity_${u}@acme.test,Finance,2026-06-01,930303031234,4800,0,,,1\nAlso Bad,nope,Finance,2026-06-01,940404041234,4800,0,,,1\n`;
    const fromFile = await validateEmployeeImport(adminCtx(b), {
      companyId: b.companyId,
      records: parseCsvRecords((await readImportFile(csvFile(text))).text).records,
    });
    const fromPaste = await validateEmployeeImport(adminCtx(b), {
      companyId: b.companyId,
      records: parseCsvRecords(text).records,
    });
    expect(fromFile).toEqual(fromPaste);
  });
});

// ── §5 source guard — composition only, NOT behaviour ──────────────────────────────────────────────
describe('§5 employee-import.tsx wiring (static — no DOM runner in this suite)', () => {
  const src = read('/app/admin/personnel/import/employee-import.tsx');
  const actions = read('/app/admin/personnel/import/actions.ts');

  it('has a real file input, wired to the reader and to the accept list', () => {
    expect(src).toMatch(/type="file"/);
    expect(src).toMatch(/accept=\{IMPORT_FILE_ACCEPT\}/);
    expect(src).toMatch(/readImportFile/);
    // The change handler hands the picked File to loadFile.
    expect(src).toMatch(/e\.target\.files\?\.\[0\][\s\S]{0,80}loadFile\(f\)/);
    // …and so does a drop.
    expect(src).toMatch(/dataTransfer\.files\?\.\[0\][\s\S]{0,80}loadFile\(f\)/);
  });

  it('the file path feeds the SAME validate/commit actions as the paste path', () => {
    // loadFile ends in the shared validate; commit still sends the shared csv string.
    // r253 (2983802f): the employee importer gained a SECOND sheet (Family), so both calls carry one
    // more argument — the family rows, as CSV text, decoded from the same workbook in the same browser.
    // Widened rather than pinned to the old arity for the same reason the commit call below was widened
    // in r88: the subject of this assertion is "the file path and the paste path go through ONE shared
    // validate", which the single-call-site counts underneath are what actually enforce.
    expect(src).toMatch(/const loadFile[\s\S]*?runValidate\(text(,[^)]*)?\)/);
    expect(src).toMatch(/validateImportAction\(text, companyId(,[^)]*)?\)/);
    // r88 (cf43c909): commit now also carries the FILE NAME, because import history records what was
    // uploaded. Widened rather than pinned to the old two-arg form — the subject of this assertion is
    // "one shared commit action", not its arity. The single-call-site checks below are what actually
    // enforce that no file-specific server action was introduced.
    expect(src).toMatch(/commitImportAction\(csv, companyId(,[^)]*)?\)/);
    // Exactly one call site each — no second, file-specific server action was introduced.
    expect(src.match(/validateImportAction\(/g) ?? []).toHaveLength(1);
    expect(src.match(/commitImportAction\(/g) ?? []).toHaveLength(1);
  });

  it('leaves the parse and write path untouched (actions.ts still just parses and delegates)', () => {
    expect(actions).toMatch(/parseCsvRecords\(csv\)/);
    // r253 (2983802f): both payloads gained `dependentRecords` — the Family sheet, parsed by the SAME
    // parser on the same line of the same file — so the object literals are now multi-line. Still the
    // same two delegate calls carrying the same companyId + records; the point of this case is that
    // actions.ts parses and delegates and does nothing else, which the FormData/File check below is what
    // enforces.
    expect(actions).toMatch(/validateEmployeeImport\(s, \{[\s\S]{0,200}?companyId,[\s\S]{0,200}?records[\s\S]{0,200}?\}\)/);
    // r88 (cf43c909): the commit payload gained `fileName` so the import-history row can name what was
    // uploaded. Still the same delegate call with the same companyId + records — only extra scalars.
    expect(actions).toMatch(/commitEmployeeImport\(s, \{[\s\S]{0,300}?companyId,[\s\S]{0,300}?records[\s\S]{0,300}?\}\)/);
    // No file/FormData handling leaked to the server — the reader is browser-side by design so
    // d8471481 can swap it without touching anything that writes. A file NAME is a string and is fine;
    // a File OBJECT or FormData would mean the reader had moved server-side, which is what this forbids.
    expect(actions).not.toMatch(/FormData|File\b/);
  });

  it('keeps the paste box as a secondary path', () => {
    expect(src).toMatch(/<textarea/);
    expect(src).toMatch(/t\('pasteToggle'\)/);
  });

  it('keeps check-before-create: the preview renders before any commit is offered', () => {
    // The guard is unchanged; d8471481 only broke the JSX across lines to pass the error-report
    // handler down, so the assertion matches the CONDITION rather than a one-line formatting of it.
    expect(src).toMatch(/preview && !result && \(?\s*<PreviewTable/);
    // The import button lives inside the preview and is disabled when nothing is importable.
    // r253 (2983802f): "nothing is importable" gained a second cause. A file whose Family sheet names an
    // employee it does not contain is refused WHOLE — valid rows included — so the button is disabled on
    // `fileErrors` too. The two conditions are asserted together rather than loosened to a wildcard,
    // because dropping either one is the defect this case exists to catch.
    expect(src).toMatch(/onClick=\{onImport\}[\s\S]{0,200}?preview\.validCount === 0/);
    expect(src).toMatch(/onClick=\{onImport\}[\s\S]{0,200}?preview\.fileErrors\.length > 0/);
  });

  it('renders rejected rows, their reasons, and missing columns', () => {
    // Preview: every row is mapped (no filter to the valid ones) and !ok rows print their errors.
    // d8471481 added an error-report DOWNLOAD that filters to the failed rows — which is the whole
    // point of an error report — so the no-filtering rule is asserted on the TABLE BODY only.
    expect(src).toMatch(/preview\.rows\.map\(\(r\) =>/);
    const tableBody = src.slice(src.indexOf('<tbody'), src.indexOf('</tbody>'));
    expect(tableBody).not.toMatch(/preview\.rows\.filter/);
    expect(src).toMatch(/onDownloadErrors\(preview\.rows\.filter\(\(r\) => !r\.ok\)\)/);
    expect(src).toMatch(/r\.errors\.join\('; '\)/);
    expect(src).toMatch(/preview\.missingColumns\.map/);
    // Result card: failures listed with row number and message.
    expect(src).toMatch(/result\.failed\.map\(\(f\) =>/);
    expect(src).toMatch(/\{f\.message\}/);
  });

  it('does not paginate the preview (r75 — a hidden row is a row nobody approved)', () => {
    const previewTable = src.slice(src.indexOf('function PreviewTable'));
    expect(previewTable).not.toMatch(/\bslice\(|\bpage\b|Pagination|perPage/);
  });
});
