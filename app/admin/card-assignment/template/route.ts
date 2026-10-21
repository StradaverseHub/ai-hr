import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getScopeIds } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { isAdmin } from '@/lib/authz-model';
import { assertCardImportAccess, cardImportExisting } from '@/packs/attendance/service';
import { buildCardImportWorkbook } from '@/lib/card-import-workbook';
import { CardImportError } from '@/lib/card-import';
import { publicErrorMessage } from '@/lib/public-error';
export async function GET(request: Request) {
  const ctx = await getSession(), t = await getTranslations('cardImport'), params = new URL(request.url).searchParams;
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!isAdmin(ctx)) return Response.json({ error: t('scope') }, { status: 403, headers });
  let scope = await getScopeIds((await allowedCompanies(ctx)).map(c => c.id));
  const company = params.get('company');
  if (company) { if (!scope.includes(company)) return Response.json({ error: t('scope') }, { status: 403, headers }); scope = [company]; }
  try {
    await assertCardImportAccess(ctx, scope);
    const guidance = [t('bulkTitle'), t('templateLayout'), t('limits'), `assign: ${t('assignHelp')}`,
      `replace: ${t('replaceHelp')}`, `reset: ${t('resetHelp')}`, t('confirmationRequired'),
      t('duplicateEmployee'), t('duplicateCard'), t('reviewHelp')];
    const bytes = buildCardImportWorkbook(params.get('existing') === '1' ? await cardImportExisting(ctx, scope) : [], guidance);
    return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="Card_Assignments_${params.get('existing') === '1' ? 'Existing' : 'Template'}.xlsx"`, 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    if (!(error instanceof CardImportError)) publicErrorMessage(error);
    return Response.json({ error: t(error instanceof CardImportError ? error.code : 'saveFailed') }, { status: error instanceof CardImportError && error.code === 'scope' ? 403 : 400, headers });
  }
}
