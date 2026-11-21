// Recruitment slice 16 — download an export (CSV or Excel), generated on request and never stored. The service reads under the
// exporter's own row security (the board and a job's interview feedback: administrators and the company's recruiters and
// assistants; the talent pool: those who may open it), refuses more than 10,000 rows, and this route writes the audit event (who,
// kind, filters as ids, format, column and row counts — never a value) before sending the file. Every cell, headers included,
// goes through the formula-injection guard (lib/csv csvSafeCell). A refusal returns to the page it came from with ?problem=<code>.
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { buildXlsx } from '@/lib/spreadsheet';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  exportBoard, exportCsv, exportFileName, exportInterviewFeedback, exportTalentPool, exportTemplateColumns, isCustomColumn, isExportKind, parseExportFormat,
  recordExport, RecruitmentError, CANDIDATE_SOURCES, EDUCATION_LEVELS, EVALUATION_RESULTS, ID_TYPES, type ExportCell, type ExportTable,
} from '@/packs/recruitment/service';

export const runtime = 'nodejs';
const HARDENING = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } as const;
const back = (q: URLSearchParams) => {
  const to = q.get('returnTo') ?? '';
  return to.startsWith('/recruitment') && !to.startsWith('//') ? to : '/recruitment/candidates';
};
const withProblem = (url: string, code: string) => `${url}${url.includes('?') ? '&' : '?'}problem=${encodeURIComponent(code)}`;

export async function GET(req: Request) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const url = new URL(req.url);
  const q = url.searchParams;
  const kind = q.get('kind');
  const returnTo = back(q);
  if (!isExportKind(kind)) return Response.redirect(new URL(withProblem(returnTo, 'invalid_input'), url), 303);
  const format = parseExportFormat(q.get('format'));
  const opt = (key: string) => q.get(key) || undefined;
  try {
    const template = opt('template');
    const asked = template ? await exportTemplateColumns(s, template, kind) : q.getAll('columns');
    if (template && !asked) throw new RecruitmentError('not_found');
    const locale = await getLocale();
    let table: ExportTable;
    let companyIds: string[] = scopeIds;
    let filters: Record<string, string | undefined>;
    if (kind === 'board') {
      filters = { job: opt('job'), tab: opt('tab'), tag: opt('tag'), custom: opt('cf') };
      table = await exportBoard(s, scopeIds, { jobId: filters.job, tab: filters.tab, tagId: filters.tag, custom: filters.custom }, asked, locale);
    } else if (kind === 'talent_pool') {
      filters = { job: opt('job'), reason: opt('reason'), since: opt('since'), tag: opt('tag'), custom: opt('cf') };
      table = await exportTalentPool(s, scopeIds, { jobId: filters.job, reasonId: filters.reason, since: filters.since, tagId: filters.tag, custom: filters.custom }, asked, locale);
    } else {
      filters = { job: opt('job') };
      const feedback = await exportInterviewFeedback(s, filters.job, asked);
      companyIds = [feedback.companyId];
      table = feedback;
    }
    const t = await getTranslations('recruitment.exports');
    const tc = await getTranslations('recruitment.cand');
    const tf = await getTranslations('recruitment.fb');
    const headers = table.columns.map((c) => (isCustomColumn(c) ? table.customLabels[c] ?? c : t(`columns.${c}` as 'columns.candidateName')));
    // Stored choices in the reader's language (the enum lists are fixed; anything else is shown as stored).
    const word = (column: string, v: ExportCell): ExportCell => {
      if (typeof v !== 'string') return v;
      if (column === 'status' && ['active', 'hired', 'archived'].includes(v)) return t(`status.${v}` as 'status.active');
      if (column === 'source' && (CANDIDATE_SOURCES as readonly string[]).includes(v)) return tc(`sources.${v}` as 'sources.other');
      if (column === 'highestEducation' && (EDUCATION_LEVELS as readonly string[]).includes(v)) return tc(`educationLevels.${v}` as 'educationLevels.other');
      if (column === 'idType' && (ID_TYPES as readonly string[]).includes(v)) return tc(`idTypes.${v}` as 'idTypes.nric');
      if (column === 'result' && (EVALUATION_RESULTS as readonly string[]).includes(v)) return tf(`results.${v}` as 'results.recommended');
      if (column === 'needsReview' || (isCustomColumn(column) && (v === 'yes' || v === 'no'))) return v === 'yes' ? t('yes') : v === 'no' ? t('no') : v;
      return v;
    };
    const rows = table.rows.map((r) => r.map((v, i) => word(table.columns[i], v)));
    // The audit event first: no file leaves without its record.
    await recordExport(s, { kind, companyIds, format, filters: { ...filters, template }, columns: table.columns.length, rows: rows.length });
    const name = exportFileName(kind, todayInKualaLumpur(), format);
    if (format === 'xlsx') {
      // Excel cells are typed: a string cell is never evaluated as a formula, so XLSX strings are written as they are (CSV keeps
      // the guard), and numbers stay numbers.
      const body = rows.map((r) => r.map((v) => (v === null ? '' : v))) as unknown as string[][];
      const bytes = await buildXlsx(headers, body, { sheetName: t(`kinds.${kind}` as 'kinds.board').slice(0, 31) });
      return new Response(new Uint8Array(bytes), { headers: { ...HARDENING, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"` } });
    }
    return new Response(exportCsv(headers, rows), { headers: { ...HARDENING, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });
  } catch (e) {
    if (!(e instanceof RecruitmentError)) console.error('recruitment export failed', e instanceof Error ? e.name : typeof e);
    return Response.redirect(new URL(withProblem(returnTo, e instanceof RecruitmentError ? e.code : 'unexpected'), url), 303);
  }
}
