/** Preview and per-employee atomic confirmation over the existing card setter. No assignment master. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type Grant, type SessionContext, type Tx } from '../db/client';
import { employment, person } from '../db/schema';
import { isAdmin } from '../lib/authz-model';
import { assertModuleGate } from './module-gate';
import { CardIdInUseError, CardIdStateError, setEmploymentCardId } from './attendance-card';
import { readCardImportWorkbook } from '../lib/card-import-workbook';
import { CARD_IMPORT_MAX_ROWS, CardImportError, cardImportFileName, cardImportKey, validateCardImportRows, type CardImportInput, type CardImportPreview, type CardImportResult, type CardImportResultRow, type CardImportRow } from '../lib/card-import';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A preview is deliberately short-lived and write-free. A restart/other worker requires a fresh
// review; this key is not a durable credential and never reuses an authentication or PII key.
const runtime = globalThis as typeof globalThis & { __aihrCardReviewKey?: Buffer };
const reviewKey = runtime.__aihrCardReviewKey ??= randomBytes(32);
type Review = { tenant: string; user: string; scope: string[]; fileHash: string; fileName: string; expires: number; rows: { row: number; fingerprint: string | null }[] };
function sign(review: Review): string {
  const body = Buffer.from(JSON.stringify(review)).toString('base64url');
  return body + '.' + createHmac('sha256', reviewKey).update('aihr:card-review:v1\0' + body).digest('base64url');
}
function verify(token: string, ctx: SessionContext, scope: string[], fileHash: string, fileName: string): Review {
  if (typeof token !== 'string' || token.length > 100_000) throw new CardImportError('invalidReview');
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new CardImportError('invalidReview');
  const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', reviewKey).update('aihr:card-review:v1\0' + body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CardImportError('invalidReview');
  let r: Review;
  try { r = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new CardImportError('invalidReview'); }
  if (r.tenant !== ctx.tenantId || r.user !== ctx.userId || JSON.stringify(r.scope) !== JSON.stringify([...scope].sort()) || r.fileHash !== fileHash || r.fileName !== fileName || r.expires < Date.now() || !Array.isArray(r.rows) || r.rows.length > CARD_IMPORT_MAX_ROWS) throw new CardImportError('invalidReview');
  return r;
}
async function assertAuthority(tx: Tx, ctx: SessionContext, scope: readonly string[]) {
  assertModuleGate(ctx, 'attendance');
  if (!isAdmin(ctx) || !ctx.userId || !scope.length || scope.length > 100 || scope.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) throw new CardImportError('scope');
  // Recheck the login, its person and actual grants; a stale preview/session cannot preserve access.
  const [p] = await tx.execute(sql`select p.tenant_id,p.person_id,p.grants,u.archived_at,app.login_blocked(u.id) as blocked from app.principal(${ctx.userId}::uuid) p join app_user u on u.id=${ctx.userId}::uuid`) as unknown as { tenant_id: string; person_id: string | null; grants: Grant[]; archived_at: Date | null; blocked: boolean }[];
  const canonical = (grants: readonly Grant[]) => JSON.stringify(grants.map(g => [g.role, g.companyId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const expected = ctx.grants ?? (ctx.roles ?? []).map(role => ({ role, companyId: null }));
  if (!p || p.tenant_id !== ctx.tenantId || p.person_id !== (ctx.personId ?? null) || p.archived_at || p.blocked || canonical(p.grants) !== canonical(expected)) throw new CardImportError('scope');
  const allowed = await tx.execute(sql`select id from company where tenant_id=app.current_tenant_id() and app.is_admin_for(id) and id in (${sql.join(scope.map(id => sql`${id}::uuid`), sql`,`)})`) as unknown as { id: string }[];
  if (allowed.length !== new Set(scope).size) throw new CardImportError('scope');
}
async function previewTx(tx: Tx, ctx: SessionContext, scope: string[], inputs: readonly CardImportInput[]): Promise<CardImportRow[]> {
  await assertAuthority(tx, ctx, scope);
  const rows = validateCardImportRows(inputs);
  const keys = [...new Set(rows.map(row => cardImportKey(row.employeeCode)).filter(Boolean))];
  const candidates = keys.length ? await tx.select({ id: employment.id, employeeCode: employment.employeeCode, cardId: employment.cardId, companyId: employment.companyId, employee: person.fullName })
    .from(employment).innerJoin(person, eq(person.id, employment.personId))
    .where(and(eq(employment.tenantId, ctx.tenantId), isNull(employment.terminatedOn), inArray(employment.companyId, scope), sql`app.is_admin_for(${employment.companyId})`, sql`lower(btrim(${employment.employeeCode})) in (${sql.join(keys.map(code => sql`${code}`), sql`,`)})`))
    .orderBy(asc(employment.id)).limit(CARD_IMPORT_MAX_ROWS * 2 + 1) : [];
  if (candidates.length > CARD_IMPORT_MAX_ROWS * 2) throw new CardImportError('catalogueLimit');
  for (const row of rows) {
    const matches = candidates.filter(e => cardImportKey(e.employeeCode ?? '') === cardImportKey(row.employeeCode));
    if (matches.length !== 1) { row.issues.push(matches.length ? 'ambiguousEmployee' : 'unavailableEmployee'); row.effect = 'failed'; continue; }
    const e = matches[0];
    row.employmentId = e.id; row.companyId = e.companyId; row.employee = e.employee; row.matchedEmployeeCode = e.employeeCode!; row.previousCard = e.cardId;
    row.nextCard = row.operation === 'reset' ? null : row.cardId || e.cardId;
    row.effect = row.nextCard === e.cardId ? 'unchanged' : row.operation === 'reset' ? 'reset' : e.cardId ? 'replace' : 'assign';
    if (row.effect === 'replace' && row.operation !== 'replace') row.issues.push('existingCard');
    if (!row.issues.length && row.nextCard && row.effect !== 'unchanged') {
      const [available] = await tx.execute(sql`select app.card_identifier_free(${e.id}::uuid,${row.nextCard}) as ok`) as unknown as { ok: boolean }[];
      if (!available?.ok) row.issues.push('cardConflict');
    }
    if (row.issues.length) row.effect = 'failed';
    else row.fingerprint = hash({ id: e.id, company: e.companyId, employeeCode: e.employeeCode, card: e.cardId, next: row.nextCard, operation: row.operation });
  }
  return rows;
}
export async function previewCardImport(ctx: SessionContext, scope: string[], bytes: Buffer, name: string): Promise<CardImportPreview> {
  const inputs = readCardImportWorkbook(bytes), fileHash = createHash('sha256').update(bytes).digest('hex'), fileName = cardImportFileName(name);
  const rows = await withTenant(ctx, tx => previewTx(tx, ctx, scope, inputs));
  return { rows, fileHash, fileName, receipt: sign({ tenant: ctx.tenantId, user: ctx.userId!, scope: [...scope].sort(), fileHash, fileName, expires: Date.now() + 15 * 60_000, rows: rows.map(r => ({ row: r.row, fingerprint: r.fingerprint ?? null })) }) };
}
export async function commitCardImport(ctx: SessionContext, scope: string[], bytes: Buffer, name: string, token: string, selection: readonly number[], confirmReplacements: boolean): Promise<CardImportResult> {
  const inputs = readCardImportWorkbook(bytes), fileHash = createHash('sha256').update(bytes).digest('hex'), fileName = cardImportFileName(name);
  const review = verify(token, ctx, scope, fileHash, fileName);
  if (!Array.isArray(selection) || selection.length > CARD_IMPORT_MAX_ROWS || new Set(selection).size !== selection.length || selection.some(value => !Number.isInteger(value) || !inputs.some(r => r.row === value))) throw new CardImportError('invalidReview');
  const reviewed = new Map(review.rows.map(r => [r.row, r.fingerprint]));
  const fresh = await withTenant(ctx, tx => previewTx(tx, ctx, scope, inputs));
  const rows: CardImportResultRow[] = [];
  for (const row of fresh) {
    if (row.issues.length) { rows.push({ ...row, result: 'failed' }); continue; }
    if (!selection.includes(row.row)) { rows.push({ ...row, issues: ['notSelected'], result: 'skipped' }); continue; }
    if (!reviewed.get(row.row) || reviewed.get(row.row) !== row.fingerprint) { rows.push({ ...row, issues: ['stale'], result: 'failed' }); continue; }
    if (['replace', 'reset'].includes(row.effect) && !confirmReplacements) { rows.push({ ...row, issues: ['confirmationRequired'], result: 'failed' }); continue; }
    try {
      await withTenant(ctx, async tx => {
        await assertAuthority(tx, ctx, scope);
        // Re-resolve the employee code under the same tenant lock used by every identifier writer.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':card-identifiers'},0))`);
        const [current] = await previewTx(tx, ctx, scope, [row]);
        if (current.issues.length || current.fingerprint !== row.fingerprint) throw new CardIdStateError('stale');
        if (row.effect !== 'unchanged') await setEmploymentCardId(ctx, {
          employmentId: row.employmentId!, cardId: row.nextCard!,
          expected: { cardId: row.previousCard!, companyId: row.companyId!, employeeCode: row.matchedEmployeeCode! },
          importSource: { fileName, fileHash, row: row.row },
        }, tx);
      });
      rows.push({ ...row, result: row.effect === 'unchanged' ? 'unchanged' : row.effect === 'assign' ? 'imported' : 'updated' });
    } catch (error) {
      const issue = error instanceof CardIdInUseError ? 'cardConflict' : error instanceof CardIdStateError ? error.code === 'conflict' ? 'cardConflict' : 'stale' : 'saveFailed';
      rows.push({ ...row, issues: [issue], result: 'failed' });
    }
  }
  const count = (result: CardImportResultRow['result']) => rows.filter(row => row.result === result).length;
  return { rows, total: rows.length, imported: count('imported'), updated: count('updated'), unchanged: count('unchanged'), failed: count('failed'), skipped: count('skipped') };
}
export async function cardImportExisting(ctx: SessionContext, scope: string[]) {
  return withTenant(ctx, async tx => {
    await assertAuthority(tx, ctx, scope);
    const rows = await tx.select({ employeeCode: employment.employeeCode, cardId: employment.cardId }).from(employment)
      .where(and(eq(employment.tenantId, ctx.tenantId), inArray(employment.companyId, scope), isNull(employment.terminatedOn), sql`app.is_admin_for(${employment.companyId})`, sql`${employment.employeeCode} is not null`))
      .orderBy(asc(employment.employeeCode), asc(employment.id)).limit(CARD_IMPORT_MAX_ROWS + 1);
    if (rows.length > CARD_IMPORT_MAX_ROWS) throw new CardImportError('catalogueLimit');
    return rows.map(row => ({ employeeCode: row.employeeCode!, cardId: row.cardId }));
  });
}
export async function assertCardImportAccess(ctx: SessionContext, scope: string[]) {
  await withTenant(ctx, tx => assertAuthority(tx, ctx, scope));
}
