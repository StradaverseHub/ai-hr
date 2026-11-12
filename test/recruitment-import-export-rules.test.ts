/**
 * Recruitment slice 16 — the pure rules of the candidate import file (packs/recruitment/import-model.ts) and of exports
 * (packs/recruitment/export-model.ts): reading and checking a file row by row, the template header, possible duplicates within a file,
 * the job result, the permission confirmation, the export columns, the cap, saved column sets and the formula-injection guard; and
 * the static shape of migration 5217 and the kind's registration. No database. The database behaviour (cases 108–113) is
 * test/recruitment-import.test.ts and test/recruitment-export.test.ts.
 *
 * Expected values are written out by hand from each fixture, never computed with the module under test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_IMPORT_KIND, EXPORT_MAX_ROWS, IMPORT_MAX_ROWS, chooseExportColumns, exportCsv, exportFileName, importTemplateHeader, parseCandidateImport, permissionConfirmed,
  normHeader, requiredIssues,
  safeRows, validateExportTemplate, RECRUITMENT_ERROR_CODES, TODO_KINDS, todoHref,
} from '../packs/recruitment/service';
import { fileDuplicates, jobResultOf, needsJobIssues, ImportFileRefusal, type ImportField } from '../packs/recruitment/import-model';
import { assertExportSize } from '../packs/recruitment/export-model';
import { BULK_JOB_NOTICES, bulkJobNoticeKeys } from '../lib/bulk-job';
import { toCsv } from '../lib/csv';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L = (en: string) => ({ en, ms: null, ta: null, th: null, vi: null, zh: en === 'Morning' ? '早班' : null });
const SHIFT: ImportField = { id: id(1), type: 'single_choice', labels: L('Shift'), required: false, restricted: false, numberMin: null, numberMax: null, numberDecimals: null,
  options: [{ id: id(11), labels: L('Morning'), enabled: true }, { id: id(12), labels: L('Night'), enabled: true }, { id: id(13), labels: L('Weekend'), enabled: false }] };
const LANGS: ImportField = { id: id(2), type: 'multiple_choice', labels: L('Languages'), required: false, restricted: false, numberMin: null, numberMax: null, numberDecimals: null,
  options: [{ id: id(21), labels: L('Malay'), enabled: true }, { id: id(22), labels: L('English'), enabled: true }] };
const YEARS: ImportField = { id: id(3), type: 'number', labels: L('Years'), required: true, restricted: false, numberMin: '0', numberMax: '60', numberDecimals: 0, options: [] };
const REMOTE: ImportField = { id: id(4), type: 'yes_no', labels: L('Remote'), required: false, restricted: true, numberMin: null, numberMax: null, numberDecimals: null, options: [] };
const FIELDS = [SHIFT, LANGS, YEARS, REMOTE];
const refusal = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return e instanceof ImportFileRefusal ? e.code : String(e); } };

describe('the import file', () => {
  it('reads the template header (fixed English columns, then the custom fields by English label) and maps choices, yes/no and numbers', () => {
    expect(importTemplateHeader(FIELDS)).toEqual(['Full name *', 'E-mail', 'Mobile', 'ID type', 'ID number', 'Source', 'Job number', 'Job title as written', 'Notes',
      'Shift', 'Languages', 'Years', 'Remote']);
    const text = toCsv([
      ['Full name *', 'E-mail', 'Mobile', 'ID type', 'ID number', 'Source', 'Job number', 'Job title as written', 'Notes', 'Shift', 'Languages', 'Years', 'Remote', 'Favourite colour'],
      ['  Fictional Ana  ', 'ANA@Example.TEST', '011-111', 'Passport', 'A123', 'Job board', 'mj000001', 'Fictional analyst', 'Line one\r\nline two', '早班', 'Malay; English', '7', 'Y', 'Blue'],
    ]);
    const parsed = parseCandidateImport(`\uFEFF${text}`, FIELDS);
    expect(parsed.ignoredColumns).toEqual(['Favourite colour']);
    expect(parsed.customColumns).toEqual([id(1), id(2), id(3), id(4)]);
    expect(parsed.rows).toEqual([{
      rowNum: 2, issues: [],
      values: { fullName: 'Fictional Ana', email: 'ana@example.test', phone: '011-111', idType: 'passport', idNumber: 'A123', source: 'job_board', jobNumber: 'MJ000001',
        jobTitle: 'Fictional analyst', notes: 'Line one\nline two' },
      custom: { [id(1)]: [id(11)], [id(2)]: [id(21), id(22)], [id(3)]: '7', [id(4)]: 'yes' },
    }]);
  });

  it('finds every bad row and field (codes and keys only, never the value); a row that is all empty is skipped', () => {
    const h = ['Full name', 'E-mail', 'Mobile', 'ID type', 'ID number', 'Source', 'Job number', 'Shift', 'Years'];
    const text = toCsv([h,
      ['', 'a@example.test', '', '', '', '', '', '', '1'],                  // 2: no name
      ['Fictional B', 'not-an-email', '', '', '', '', '', '', '1'],          // 3: bad e-mail
      ['Fictional C', '', '', '', 'X1', '', '', '', '1'],                    // 4: ID number without its type
      ['Fictional D', '', '', 'licence', '', '', '', '', '1'],               // 5: an unknown ID type
      ['Fictional E', '', '', '', '', 'newspaper', '', '', '1'],             // 6: an unknown source
      ['Fictional F', '', '', '', '', '', '', 'Weekend', '1'],               // 7: a disabled option
      ['Fictional G', '', '', '', '', '', '', '', '61'],                     // 8: a number out of range
      ['Fictional H', '', '', '', '', '', '', '', ''],                       // 9: a required field empty
      ['', '', '', '', '', '', '', '', ''],                                  // 10: empty — skipped
      ['X'.repeat(201), '', '1'.repeat(41), '', '', '', '', '', '1'],        // 11: too long name and mobile
    ]);
    const parsed = parseCandidateImport(text, FIELDS);
    expect(parsed.rows.map((r) => [r.rowNum, r.values === null, r.issues])).toEqual([
      [2, true, [{ field: 'fullName', code: 'required' }]],
      [3, true, [{ field: 'email', code: 'invalid' }]],
      [4, true, [{ field: 'idType', code: 'id_type_required' }]],
      [5, true, [{ field: 'idType', code: 'invalid' }]],
      [6, true, [{ field: 'source', code: 'invalid' }]],
      [7, true, [{ field: `cf.${id(1)}`, code: 'custom_value_invalid' }]],
      [8, true, [{ field: `cf.${id(3)}`, code: 'custom_value_invalid' }]],
      [9, true, [{ field: `cf.${id(3)}`, code: 'custom_field_required' }]],
      [11, true, [{ field: 'fullName', code: 'too_long' }, { field: 'mobile', code: 'too_long' }]],
    ]);
    expect(JSON.stringify(parsed.rows.map((r) => r.issues))).not.toMatch(/not-an-email|newspaper|licence|Weekend|X1|61/);
  });

  it('refuses a file that cannot be imported at all', () => {
    expect(refusal(() => parseCandidateImport('', FIELDS))).toBe('import_empty');
    expect(refusal(() => parseCandidateImport('E-mail\na@example.test\n', FIELDS))).toBe('import_no_name_column');
    expect(refusal(() => parseCandidateImport('Full name\n', FIELDS))).toBe('import_empty');
    expect(refusal(() => parseCandidateImport('Full name\n"unclosed\n', FIELDS))).toBe('import_file_invalid');
    const many = ['Full name', ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `Fictional ${i}`)].join('\n');
    expect(refusal(() => parseCandidateImport(many, []))).toBe('import_too_many_rows');
    expect(refusal(() => parseCandidateImport(['Full name', ...Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `Fictional ${i}`)].join('\n'), []))).toBe('ok');
    expect(refusal(() => parseCandidateImport(`Full name\n${'x'.repeat(10 * 1024 * 1024)}`, []))).toBe('import_too_large');
  });

  it('flags later rows of the same file that look like the same person (slice 5\'s rule: ID number, or two of name, e-mail and mobile)', () => {
    const text = toCsv([['Full name', 'E-mail', 'Mobile', 'ID type', 'ID number'],
      ['Fictional Ana', 'ana@example.test', '011', '', ''],      // 2
      ['fictional  ANA', 'ANA@example.test', '', '', ''],       // 3: name + e-mail of row 2
      ['Fictional Ana', '', '', '', ''],                         // 4: name only — not a duplicate
      ['Someone Else', '', '', 'NRIC', '900101-01-0001'],        // 5
      ['Different', '', '', 'NRIC', '900101010001'],             // 6: the ID number of row 5
      ['Fictional Bo', 'bo@example.test', '011', '', ''],        // 7: mobile of row 2 only — not a duplicate
    ]);
    expect([...fileDuplicates(parseCandidateImport(text, []).rows)]).toEqual([[3, 2], [6, 5]]);
  });

  it('says what happens to a row\'s job, and what only an administrator may import without one', () => {
    expect(jobResultOf(null, undefined)).toBe('no_job');
    expect(jobResultOf('MJ000009', undefined)).toBe('unknown_job');
    expect(jobResultOf('MJ000001', { id: id(5), status: 'on_hold', operate: true })).toBe('job_not_open');
    expect(jobResultOf('MJ000001', { id: id(5), status: 'closed', operate: true })).toBe('job_not_open');
    expect(jobResultOf('MJ000001', { id: id(5), status: 'open', operate: false })).toBe('job_not_allowed');
    expect(jobResultOf('MJ000001', { id: id(5), status: 'open', operate: true })).toBe('usable');
    const values = { fullName: 'x', email: null, phone: null, idType: 'nric' as const, idNumber: 'A1', source: null, jobNumber: null, jobTitle: null, notes: 'a note' };
    expect(needsJobIssues(values, { [id(1)]: [id(11)], [id(2)]: [] })).toEqual([{ field: 'idNumber', code: 'needs_job' }, { field: `cf.${id(1)}`, code: 'needs_job' }]);
    expect(needsJobIssues({ ...values, idNumber: null, idType: null }, {})).toEqual([]);
    expect([true, 'on', 'true', '1'].map(permissionConfirmed)).toEqual([true, true, true, true]);
    expect([false, '', 'off', undefined, 'yes'].map(permissionConfirmed)).toEqual([false, false, false, false, false]);
  });
});

describe('review follow-ups: encoding, control characters, escaped headers, required fields', () => {
  it('refuses text that was not UTF-8 (a replacement character) and reports a control character per cell', () => {
    expect(refusal(() => parseCandidateImport('Full name\nFictional Ren\uFFFDe\n', FIELDS))).toBe('import_bad_encoding');
    const text = toCsv([['Full name', 'E-mail', 'Shift'], ['Fictional\u0000Nul', 'a@example.test', 'Morning'], ['Fictional Tab\tOK', 'b@example.test', 'Night\u0007']]);
    const rows = parseCandidateImport(text, FIELDS).rows;
    expect(rows.map((r) => [r.rowNum, r.values === null, r.issues])).toEqual([
      [2, true, [{ field: 'fullName', code: 'control_character' }]],
      [3, true, [{ field: `cf.${id(1)}`, code: 'control_character' }]],
    ]);
    expect(JSON.stringify(rows.map((r) => r.issues))).not.toMatch(/Nul|Night/);
  });

  it('reads back a template whose headers a spreadsheet escaped with a leading quote', () => {
    expect(normHeader("'=Score")).toBe('=score');
    expect(normHeader("  'Full name *  ")).toBe('full name');
    const header = importTemplateHeader([{ ...SHIFT, labels: L('=Shift') }]);
    const escaped = toCsv([header, ['Fictional Ana', '', '', '', '', '', '', '', '', 'Morning']]);
    expect(escaped.split('\r\n')[0]).toContain("'=Shift");
    const parsed = parseCandidateImport(escaped, [{ ...SHIFT, labels: L('=Shift') }]);
    expect(parsed.ignoredColumns).toEqual([]);
    expect(parsed.rows[0].custom).toEqual({ [id(1)]: [id(11)] });
  });

  it('reads the file without the required rule when asked, and reports required fields the same way with or without other values', () => {
    const text = toCsv([['Full name', 'Shift', 'Years'], ['Fictional A', 'Morning', ''], ['Fictional B', '', '']]);
    expect(parseCandidateImport(text, FIELDS, { required: false }).rows.map((r) => r.issues)).toEqual([[], []]);
    const rows = parseCandidateImport(text, FIELDS, { required: false }).rows;
    expect(rows.map((r) => requiredIssues(FIELDS, r.custom))).toEqual([[{ field: `cf.${id(3)}`, code: 'custom_field_required' }], [{ field: `cf.${id(3)}`, code: 'custom_field_required' }]]);
    expect(requiredIssues(FIELDS, { [id(3)]: '4' })).toEqual([]);
  });
});

describe('exports', () => {
  it('chooses known columns in the kind\'s order, custom columns after, defaults when none', () => {
    expect(chooseExportColumns('board', ['email', `cf.${id(1)}`, 'candidateName', 'nonsense', 'round'])).toEqual(['candidateName', 'email', `cf.${id(1)}`]);
    expect(chooseExportColumns('board', [`cf.${id(1)}`, `cf.${id(2)}`], new Set([id(2)]))).toEqual([`cf.${id(2)}`]);
    expect(chooseExportColumns('interview_feedback', [`cf.${id(1)}`, 'comments'])).toEqual(['comments']);
    expect(chooseExportColumns('talent_pool', [])).toEqual(['candidateName', 'email', 'mobile', 'jobTitle', 'jobNumber', 'stageLeft', 'archivedOn', 'archiveReason']);
    expect(chooseExportColumns('interview_feedback', null)).toEqual(['candidateName', 'round', 'stage', 'interviewDate', 'interviewer', 'result', 'averageScore', 'scores']);
  });

  it('checks saved column sets', () => {
    expect(validateExportTemplate({ name: '  Fictional  set ', kind: 'board', columns: ['email', 'candidateName'] }))
      .toEqual({ ok: true, value: { name: 'Fictional set', kind: 'board', columns: ['candidateName', 'email'] } });
    expect(validateExportTemplate({ name: '', kind: 'board', columns: ['email'] })).toEqual({ ok: false, code: 'missing_fields', fields: ['name'] });
    expect(validateExportTemplate({ name: 'x', kind: 'payroll', columns: ['email'] })).toEqual({ ok: false, code: 'invalid_input', fields: ['kind'] });
    expect(validateExportTemplate({ name: 'x', kind: 'board', columns: [] })).toEqual({ ok: false, code: 'missing_fields', fields: ['columns'] });
    expect(validateExportTemplate({ name: 'x', kind: 'board', columns: ['email', 'round'] })).toEqual({ ok: false, code: 'invalid_input', fields: ['columns'] });
    expect(validateExportTemplate({ name: 'x'.repeat(81), kind: 'board', columns: ['email'] })).toEqual({ ok: false, code: 'invalid_input', fields: ['name'] });
    expect(validateExportTemplate({ name: 'x', kind: 'interview_feedback', columns: [`cf.${id(1)}`] })).toEqual({ ok: false, code: 'missing_fields', fields: ['columns'] });
  });

  it('escapes every cell that a spreadsheet would read as a formula, headers included, and caps the rows', () => {
    const rows = [['=1+1', '+60123', '-5', '@SUM(A1)', '\tTAB', '\rCR', 'plain', 3, null]];
    expect(safeRows(['=Header', 'B'], rows)).toEqual([["'=Header", 'B'], ["'=1+1", "'+60123", "'-5", "'@SUM(A1)", "'\tTAB", "'\rCR", 'plain', '3', '']]);
    const file = exportCsv(['Name'], [['=HYPERLINK("http://x","y")'], ['Fictional, with comma']]);
    expect(file).toBe('\uFEFFName\r\n"\'=HYPERLINK(""http://x"",""y"")"\r\n"Fictional, with comma"\r\n');
    expect(EXPORT_MAX_ROWS).toBe(10000);
    expect(() => assertExportSize(10000)).not.toThrow();
    expect(() => assertExportSize(10001)).toThrow(/export_too_large/);
    expect(exportFileName('talent_pool', '2026-11-12', 'xlsx')).toBe('talent-pool-2026-11-12.xlsx');
  });
});

describe('5217 static shape and registration', () => {
  const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as { entries: { idx: number; when: number; tag: string }[] };
  const migration = read('db/migrations/5217_recruitment_import_export.sql');
  it('is journalled once at idx 4617 / when 1793330004917, right after 5216', () => {
    const at = journal.entries.findIndex((e) => e.tag === '5217_recruitment_import_export');
    expect(journal.entries.filter((e) => e.tag === '5217_recruitment_import_export')).toEqual([expect.objectContaining({ idx: 4617, when: 1793330004917 })]);
    expect(journal.entries[at - 1]?.tag).toBe('5216_recruitment_position_templates');
  });
  it('registers the kind with the kernel, its handler and its completion notice', () => {
    expect(CANDIDATE_IMPORT_KIND).toBe('recruitment_candidate_import');
    expect(migration).toMatch(/INSERT INTO bulk_job_kind\(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner\)\s+VALUES\('recruitment_candidate_import',NULL,'creator'/);
    expect(read('core/bulk-job-handlers.ts')).toMatch(/recruitmentCandidateImportJobHandler\]/);
    expect(BULK_JOB_NOTICES.recruitment_candidate_import).toEqual({ messages: 'recruitmentImport', linkPath: '/recruitment/candidates/import' });
    expect(bulkJobNoticeKeys('recruitment_candidate_import', 'completed')?.title).toBe('bulkJobs.notification.recruitmentImport.completed.title');
  });
  it('grants nothing to PUBLIC and forces row security on every new table', () => {
    for (const t of ['recruitment_candidate_import', 'recruitment_candidate_import_row', 'recruitment_to_assign', 'recruitment_candidate_import_note', 'recruitment_export_template']) {
      expect(migration).toContain(`'${t}'`);
    }
    expect(migration).toContain("EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);");
    expect(migration).toContain("EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);");
    expect(migration).not.toMatch(/GRANT [^;]* TO PUBLIC/i);
  });
  it('adds the new refusal codes and the Overview To assign kind', () => {
    expect(RECRUITMENT_ERROR_CODES).toEqual(expect.arrayContaining(['import_file_invalid', 'import_changed', 'import_running', 'import_finished', 'not_to_assign', 'job_not_open',
      'export_too_large', 'export_busy', 'export_too_slow', 'import_too_heavy', 'import_preview_limit']));
    expect(TODO_KINDS).toContain('toAssign');
    expect(todoHref('toAssign', { id: id(9) })).toBe(`/recruitment/to-assign?company=${id(9)}`);
  });
});
