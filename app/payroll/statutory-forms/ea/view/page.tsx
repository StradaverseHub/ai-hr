import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listStatutoryCatalog } from '@/core/reporting';
import { StatutoryPdfViewer } from '@/components/statutory-pdf-viewer';
import { StatutoryVersionSwitch } from '@/components/statutory-version-switch';
import { defaultVersion } from '../../criteria';
import { viewerIds, viewerPairs, viewerQuery } from '../../viewer-params';

/**
 * r402 (item f3cf2444) — THE C.P.8A (EA), OPENED INSIDE THE PRODUCT.
 *
 * The picker's Preview used to open `…/ea/preview` in a new browser tab. It comes here instead: the
 * shared viewer (components/statutory-pdf-viewer.tsx), full width, with the form's name, a Version switch,
 * Download and Back along the top, and the SAME inline route in a frame below. Nothing here renders,
 * reads or totals a statement — the framed route and the download are r331's, untouched, and both run
 * their own gate on every request.
 *
 * ⚠️ THE HEADER IS THIS PAGE'S, SO IT CHECKS SCOPE ITSELF. A company name printed above the frame is not
 * protected by the frame's gate: an out-of-scope or malformed companyId is treated as absent and goes
 * back to the criteria step, the rule the picker applies.
 *
 * Arriving with nobody ticked is the picker's job, not an error: it goes back to the list.
 */
export default async function EaViewerPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; year?: string; lang?: string; id?: string | string[] }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const sp = await searchParams;

  const catalog = await listStatutoryCatalog(s, scopeIds);
  const entry = catalog.links.find((l) => l.href.startsWith('/payroll/statutory-forms/ea?')) ?? null;
  if (!entry) notFound();

  const lang = defaultVersion(entry.versions, sp.lang);
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : '';
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : '';
  if (!companyId || !year) redirect(`/payroll/statutory-forms/open?form=${encodeURIComponent(entry.id)}&lang=${lang}`);
  const ids = viewerIds(sp.id);
  const params = { companyId, year, lang, ids };
  const query = viewerQuery(params);
  if (ids.length === 0) redirect(`/payroll/statutory-forms/ea?${query}`);

  const companies = await listCompanies(s);
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  const title = t(entry.labelKey as 'link_ea');

  return (
    <StatutoryPdfViewer
      title={title}
      subtitle={`${companyName} · ${year}`}
      pdfUrl={`/payroll/statutory-forms/ea/preview?${query}`}
      downloads={[{ href: `/payroll/statutory-forms/ea/download?${query}`, label: t('viewer_download') }]}
      back={{ href: `/payroll/statutory-forms/ea?${query}`, label: t('viewer_back') }}
      openInNewTabLabel={t('viewer_openNewTab')}
      frameTitle={t('viewer_frameTitle', { form: title })}
      controls={
        (entry.versions?.length ?? 0) > 1 ? (
          <StatutoryVersionSwitch
            action="/payroll/statutory-forms/ea/view"
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
