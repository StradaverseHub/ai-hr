import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { payItemVocabulary } from '@/core/pay-component-import';
import { listPayComponents } from '@/core/pay-components';
import { buildPayItemWorkbook } from '@/lib/pay-component-workbook';
import { todayInKualaLumpur } from '@/lib/hr-date';

export async function GET() {
  const ctx = await getSession();
  if (!isAdmin(ctx)) return new Response(null, { status: 403 });
  const [t, english] = await Promise.all([getTranslations('payComponents'), getTranslations({ locale: 'en', namespace: 'payComponents' })]);
  const catalogue = await listPayComponents(ctx, { includeArchived: true });
  const bytes = await buildPayItemWorkbook(payItemVocabulary(t, english), catalogue);
  return new Response(new Uint8Array(bytes), { headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="PayItems_Import_Template_${todayInKualaLumpur().replace(/-/g, '')}.xlsx"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
