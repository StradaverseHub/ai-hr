import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listStatutoryCatalog } from '@/core/reporting';
import { validPcb2iiSelectedDate } from '@/lib/pcb2ii-form';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { StatutoryVersionSwitch } from '@/components/statutory-version-switch';
import { defaultVersion } from '../../criteria';
import { viewerIds, viewerPairs, viewerQuery } from '../../viewer-params';

/**
 * r402 (item f3cf2444) — PCB 2(II), OPENED INSIDE THE PRODUCT.
 *
 * The same viewer as the C.P.8A (EA) beside it (components/statutory-pdf-viewer.tsx) over PCB 2(II)'s
 * existing inline route. The Selected Date rides along with company, year, version and the ticked people,
 * because the form prints it and the route refuses without it — and when the route DOES refuse (no
 * Selected Date, no signatory, a field that will not fit) it answers with a redirect to the picker, which
 * the viewer's frame follows at the top level so the refusal is read where it was written.
 *
 * The header is this page's, so it checks scope itself before printing a company name.
 */
export default async function Pcb2iiViewerPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; year?: string; lang?: string; selectedDate?: string; id?: string | string[] }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const sp = await searchParams;

  const catalog = await listStatutoryCatalog(s, scopeIds);
  const entry = catalog.links.find((l) => l.href.startsWith('/payroll/statutory-forms/pcb2ii?')) ?? null;
  if (!entry) notFound();

  const lang = defaultVersion(entry.versions, sp.lang);
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : '';
  if (!companyId || !year) redirect(`/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}&lang=${lang}`);
  const selectedDate = validPcb2iiSelectedDate(sp.selectedDate) ? sp.selectedDate! : '';
  const ids = viewerIds(sp.id);
  const params = {
    companyId,
    year,
    lang,
    ids,
    extra: selectedDate ? [{ name: 'selectedDate', value: selectedDate }] : [],
  };
  const query = viewerQuery(params);
  if (ids.length === 0) redirect(`/payroll/statutory-forms/pcb2ii?${query}`);

  const companies = await listCompanies(s);
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const title = t(entry.labelKey as 'link_pcb2ii');

  return (
    <StatutoryPdfViewer
      title={title}
      subtitle={`${companyName} · ${year}`}
      pdfUrl={`/payroll/statutory-forms/pcb2ii/preview?${query}`}
      downloads={[{ href: `/payroll/statutory-forms/pcb2ii/download?${query}`, label: t('viewer_download') }]}
      back={{ href: `/payroll/statutory-forms/pcb2ii?${query}`, label: t('viewer_back') }}
      openInNewTabLabel={t('viewer_openNewTab')}
      frameTitle={t('viewer_frameTitle', { form: title })}
      controls={
        (entry.versions?.length ?? 0) > 1 ? (
          <StatutoryVersionSwitch
            action="/payroll/statutory-forms/pcb2ii/view"
            name="lang"
            value={lang}
            options={(entry.versions ?? []).map((v) => ({ value: v.value, label: t(v.labelKey as 'version_en') }))}
            hidden={viewerPairs(params, { withLang: false })}
            label={t('version')}
            submitLabel={t('viewer_showVersion')}
          />
        ) : undefined
      }
    />
  );
}
