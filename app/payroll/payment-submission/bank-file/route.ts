import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/db/client';
import { company } from '@/db/schema';
import { scopedAdmin } from '@/lib/scope';
import { isCalendarDate } from '@/lib/calendar-date';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { readBoundedBody } from '@/lib/bounded-body';
import { listCompanyBankProfiles } from '@/core/bank-profile';
import { listBatches, listFilableRunsForPeriod } from '@/packs/payroll/service';
import { packFor } from '@/localization/registry';
import { BankPaymentFileError, type BankPaymentRequest } from '@/localization/country-pack';
import { submissionFormat } from '../registry';

export const runtime = 'nodejs';
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const period = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/);
const base = z.object({ companyId: uuid, formatId: z.string().min(1).max(64), periodKey: period }).strict();
const request = base.extend({
  bankProfileId: uuid,
  paymentDate: z.string().length(10).refine(isCalendarDate),
  runSeq: z.number().int().min(1).max(9999).optional(),
  testFile: z.boolean(),
  reference: z.string().max(16).regex(/^[\x20-\x7e]*$/),
}).strict();
const generation = request.extend({ expectedDigest: z.string().regex(/^[0-9a-f]{64}$/), requestKey: uuid }).strict();
const headers = { 'Cache-Control': 'private, no-store' };
const failure = (message: string, status: number) => Response.json({ error: message }, { status, headers });

function formatFor(p: BankPaymentRequest | z.infer<typeof base>) {
  const format = submissionFormat(p.formatId);
  return format?.available && format.transport === 'bank-post' ? format : undefined;
}
function validSelection(p: BankPaymentRequest) {
  const f = formatFor(p);
  return f && (f.periodKind === 'month-cycle' ? p.runSeq !== undefined : p.runSeq === undefined)
    && (f.testIndicator || p.testFile === false);
}
/** Scope, database permission and country contract are all checked before returning account/run data. */
async function authorize(p: z.infer<typeof base>) {
  const { s, scopeIds } = await scopedAdmin();
  if (!scopeIds.includes(p.companyId)) return null;
  const country = await withTenant(s, async (tx) => {
    const [permission] = await tx.execute<{ ok: boolean }>(sql`select app.is_admin_for(${p.companyId}::uuid) as ok`);
    if (!permission?.ok) return null;
    const [row] = await tx.select({ country: company.country }).from(company)
      .where(and(eq(company.id, p.companyId), eq(company.tenantId, s.tenantId))).limit(1);
    return row?.country;
  });
  const service = country ? packFor(country)?.bankPaymentFiles : undefined;
  return service ? { s, scopeIds, service } : null;
}
function errorResponse(error: unknown) {
  if (error instanceof BankPaymentFileError) return failure(error.message, error.status);
  return failure('Unable to generate this bank file. Please try again.', 500);
}

export async function GET(req: Request) {
  if (req.url.length > 2048) return failure('Invalid bank file request.', 400);
  const q = new URL(req.url).searchParams;
  if ([...q.keys()].some((key) => q.getAll(key).length !== 1)) return failure('Invalid bank file request.', 400);
  const raw = Object.fromEntries(q);
  const operation = raw.operation;
  delete raw.operation;
  if (operation === 'options') {
    const parsed = base.safeParse(raw);
    if (!parsed.success) return failure('Invalid bank file request.', 400);
    if (!formatFor(parsed.data)) return failure('Not found', 404);
    const auth = await authorize(parsed.data);
    if (!auth) return failure('Not found', 404);
    try {
      const [accounts, runs, batches] = await Promise.all([
        listCompanyBankProfiles(auth.s, parsed.data.companyId),
        listFilableRunsForPeriod(auth.s, { companyIds: auth.scopeIds, companyId: parsed.data.companyId, periodKey: parsed.data.periodKey }),
        listBatches(auth.s, [parsed.data.companyId], parsed.data.periodKey),
      ]);
      const ready = new Set(batches.filter((b) => !b.historyImportAttemptId && !b.needsRecalcAt && ['processed', 'closed'].includes(b.status)).map((b) => b.runSeq));
      return Response.json({
        accounts: accounts.filter((a) => a.bank === 'ocbc_bank' && a.currency === 'MYR').map((a) => ({ id: a.id, label: a.accountLabel || 'OCBC', last4: a.debitAccountNo.replace(/\D/g, '').slice(-4) })),
        runs: runs.filter((r) => ready.has(r.runSeq)),
      }, { headers });
    } catch (error) { return errorResponse(error); }
  }
  if (operation !== 'preview') return failure('Invalid bank file request.', 400);
  const { runSeq, testFile, ...rest } = raw;
  const parsed = request.safeParse({ ...rest,
    ...(runSeq === undefined ? {} : { runSeq: /^[1-9]\d{0,3}$/.test(runSeq) ? Number(runSeq) : runSeq }),
    testFile: testFile === 'true' ? true : testFile === 'false' ? false : testFile,
  });
  if (!parsed.success) return failure('Invalid bank file request.', 400);
  if (!formatFor(parsed.data)) return failure('Not found', 404);
  if (!validSelection(parsed.data)) return failure('Select exactly one ready salary run, or the whole month for statutory files.', 422);
  const auth = await authorize(parsed.data);
  if (!auth) return failure('Not found', 404);
  try { return Response.json(await auth.service.preview(auth.s, parsed.data), { headers }); }
  catch (error) { return errorResponse(error); }
}

/** POST is the only operation which allocates a TapeID and records an immutable generated file. */
export async function POST(req: Request) {
  if (!isSameOriginBrowserRequest(req)) return failure('Invalid request origin.', 403);
  if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return failure('JSON required.', 415);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(req, 4096, 10000, req.signal))); }
  catch { return failure('Invalid bank file request.', 400); }
  const parsed = generation.safeParse(raw);
  if (!parsed.success) return failure('Invalid bank file request.', 400);
  if (!formatFor(parsed.data)) return failure('Not found', 404);
  if (!validSelection(parsed.data)) return failure('Select exactly one ready salary run, or the whole month for statutory files.', 422);
  const auth = await authorize(parsed.data);
  if (!auth) return failure('Not found', 404);
  try {
    const file = await auth.service.download(auth.s, parsed.data);
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(file.filename)) throw new Error('Invalid filename');
    return new Response(file.content, { headers: { ...headers, 'Content-Type': 'text/plain; charset=us-ascii', 'Content-Disposition': `attachment; filename="${file.filename}"`, 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return errorResponse(error); }
}
