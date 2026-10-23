import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { myEaSources, myEaStatement } from '@/core/reporting';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { MyEaSelection } from './selection';
import { resolvePersonalEaSelection } from './selection-state';

export default async function MyEaPage({ searchParams }: {
  searchParams: Promise<{ year?: string; company?: string; employmentId?: string; lang?: string }>;
}) {
  await requireModule('payroll');
  const { s } = await scopedSession();
  const [sp, t, locale, sources] = await Promise.all([
    searchParams, getTranslations('myEa'), getLocale(), myEaSources(s),
  ]);
  const selected = resolvePersonalEaSelection(sources,sp);
  const language = sp.lang === 'en' || sp.lang === 'ms' ? sp.lang : locale === 'ms' ? 'ms' : 'en';
  const statement = selected?.available ? await myEaStatement(s, {
    employmentId: selected.employmentId, companyId: selected.companyId, year: selected.year,
  }) : null;
  const query = selected ? new URLSearchParams({ year: selected.year, company: selected.companyId, lang: language }) : null;
  const pdf = selected ? `/me/ea/${selected.employmentId}/pdf?${query}` : '';
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('intro')}/>
    {selected && <Card className="p-4"><MyEaSelection key={`${selected.employmentId}:${selected.companyId}:${selected.year}:${language}`} sources={sources} selected={selected} language={language} labels={{ year: t('year'), employer: t('employer'), language: t('language'), view: t('view') }}/></Card>}
    {!statement ? <Card className="space-y-2 p-8 text-center"><h2 className="font-semibold">{t('unavailable')}</h2><p className="mx-auto max-w-prose text-sm text-muted-foreground">{t('unavailableHelp')}</p></Card> : <StatutoryPdfViewer title={t('title')} subtitle={`${statement.employer.name} · ${statement.year}`} pdfUrl={`${pdf}&disposition=inline`} downloads={[{ href: pdf, label: t('download') }]} back={{ href: '/me/ea', label: t('back') }} openInNewTabLabel={t('openInNewTab')} frameTitle={t('title')}/>}
  </div>;
}
