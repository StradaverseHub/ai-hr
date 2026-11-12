// Recruitment slice 16 — the candidate import template for one company: the fixed columns and the company's enabled custom candidate
// fields by their English label (the file is a machine contract). CSV or Excel; an Excel template keeps identity columns as text so
// leading zeros survive. Only those who may import into the company (its administrators and recruiters) get it; no personal data.
import { requireModule } from '@/lib/authz';
import { buildXlsx } from '@/lib/spreadsheet';
import { toCsv } from '@/lib/csv';
import { candidateImportTemplate, IMPORT_COLUMNS, RecruitmentError } from '@/packs/recruitment/service';

export const runtime = 'nodejs';
const HARDENING = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } as const;

export async function GET(req: Request) {
  const s = await requireModule('recruitment');
  const q = new URL(req.url).searchParams;
  try {
    const template = await candidateImportTemplate(s, q.get('company'));
    if (q.get('format') === 'xlsx') {
      const text = ['mobile', 'idNumber', 'jobNumber'].map((c) => (IMPORT_COLUMNS as readonly string[]).indexOf(c));
      const bytes = await buildXlsx(template.header, [], { sheetName: 'Candidates', textColumns: text,
        extraSheets: template.customFields.some((f) => f.options.length) ? [{ name: 'Choices',
          rows: [['Field', 'Choices (separate several with ;)'], ...template.customFields.filter((f) => f.options.length).map((f) => [f.label, f.options.join('; ')])] }] : [] });
      return new Response(new Uint8Array(bytes), { headers: { ...HARDENING, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="candidate-import-template.xlsx"' } });
    }
    return new Response(`\uFEFF${toCsv([template.header])}`, { headers: { ...HARDENING, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="candidate-import-template.csv"' } });
  } catch (e) {
    if (e instanceof RecruitmentError) return new Response('Not found', { status: 404, headers: HARDENING });
    throw e;
  }
}
