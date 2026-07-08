/**
 * Custom report builder page (ADR-0074, c440b365). Server Component: resolves the dataset (from the saved
 * report, or from ?dataset when creating a new one), loads the report if editing, checks whether an AI
 * provider is configured, and hands a fully-serialisable payload to the ReportBuilder client island.
 *
 * `id === 'new'` ⇒ a fresh builder seeded with the dataset's default columns.
 */
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { isAiConfigured } from '@/core/ai-config';
import { getCustomReport } from '@/core/custom-reports';
import { datasetsForCategory, getDataset, type ReportDataset } from '@/core/report-registry';
import { REPORT_PERMISSION_VERBS, type CustomReportSpec } from '@/db/schema';
import { MATRIX_ROLES } from '@/lib/permissions';
import { PageHeader } from '@/components/ui';
import { ReportBuilder } from '../../ReportBuilder';

export const dynamic = 'force-dynamic';

/** Trim the run functions off a dataset for the client (functions can't cross the RSC boundary). */
function serialiseDataset(d: ReportDataset) {
  return { id: d.id, category: d.category, label: d.label, fields: d.fields, filters: d.filters, defaultColumns: d.defaultColumns };
}

export default async function ReportBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { s } = await scopedAdmin();
  const t = await getTranslations('reports');
  const { id } = await params;
  const sp = await searchParams;

  let existing: { id: string; name: string; spec: CustomReportSpec; shared: boolean } | null = null;
  let dataset: ReportDataset | undefined;

  if (id === 'new') {
    dataset = getDataset(sp.dataset ?? '');
    if (!dataset) redirect('/reports');
  } else {
    const r = await getCustomReport(s, id);
    if (!r) notFound();
    existing = { id: r.id, name: r.name, spec: r.spec, shared: r.shared };
    dataset = getDataset(r.datasetId);
    if (!dataset) notFound();
  }

  const aiEnabled = await isAiConfigured(s);
  const peers = datasetsForCategory(dataset.category).map(serialiseDataset);
  const roles = MATRIX_ROLES.map((r) => ({ id: r, label: t(`permRole.${r}`) }));
  const verbs = REPORT_PERMISSION_VERBS.map((v) => ({ id: v, label: t(`permVerb.${v}`) }));

  const initialSpec: CustomReportSpec =
    existing?.spec ?? { datasetId: dataset.id, columns: dataset.defaultColumns, sort: null, groupBy: null, filters: {}, layout: { orientation: 'landscape' } };

  return (
    <div className="space-y-5">
      <PageHeader
        title={existing ? t('builder.editTitle') : t('builder.newTitle')}
        description={t('builder.subtitle')}
        back={{ href: '/reports', label: t('backToReports') }}
      />
      <ReportBuilder
        reportId={existing?.id ?? null}
        name={existing?.name ?? ''}
        shared={existing?.shared ?? false}
        dataset={serialiseDataset(dataset)}
        datasets={peers}
        initialSpec={initialSpec}
        aiEnabled={aiEnabled}
        roles={roles}
        verbs={verbs}
        error={sp.error}
        toast={sp.toast}
        labels={{
          reportName: t('reportName'),
          availableFields: t('availableFields'),
          searchFields: t('searchFields'),
          selectedColumns: t('selectedColumns'),
          noColumns: t('noColumns'),
          properties: t('properties'),
          dataset: t('dataset'),
          orientation: t('orientation'),
          portrait: t('portrait'),
          landscape: t('landscape'),
          sortBy: t('sortBy'),
          groupBy: t('groupBy'),
          none: t('none'),
          ascending: t('ascending'),
          descending: t('descending'),
          filters: t('filters'),
          shareToggle: t('shareToggle'),
          summaryRow: t('summaryRow'),
          averagesRow: t('averagesRow'),
          moveUp: t('moveUp'),
          moveDown: t('moveDown'),
          remove: t('remove'),
          add: t('add'),
          preview: t('preview'),
          refreshPreview: t('refreshPreview'),
          noPreview: t('noPreview'),
          previewNote: t('previewNote'),
          save: t('save'),
          saving: t('saving'),
          saveAsTemplate: t('saveAsTemplate'),
          subtitle: t('reportSubtitle'),
          description: t('reportDescription'),
          companyLogo: t('companyLogo'),
          companyLogoHint: t('companyLogoHint'),
          paperSize: t('paperSize'),
          margins: t('margins'),
          marginNarrow: t('marginNarrow'),
          marginNormal: t('marginNormal'),
          marginWide: t('marginWide'),
          dateFormat: t('dateFormat'),
          numberFormat: t('numberFormat'),
          pageBreakOn: t('pageBreakOn'),
          header: t('header'),
          footer: t('footer'),
          watermark: t('watermark'),
          alignment: t('alignment'),
          alignLeft: t('alignLeft'),
          alignCenter: t('alignCenter'),
          alignRight: t('alignRight'),
          width: t('width'),
          freeze: t('freeze'),
          pagesApprox: t('pagesApprox'),
          permissions: t('permissions'),
          permissionsHint: t('permissionsHint'),
          role: t('role'),
          recommendations: t('recommendations'),
          suggestedColumns: t('suggestedColumns'),
          bestFormat: t('bestFormat'),
          aiTitle: t('ai.title'),
          aiDescribe: t('ai.describe'),
          aiPlaceholder: t('ai.placeholder'),
          aiGenerate: t('ai.generate'),
          aiGenerating: t('ai.generating'),
          aiNotConfigured: t('ai.notConfigured'),
          aiInvalid: t('ai.invalid'),
          aiApplied: t('ai.applied'),
          exportCsv: t('exportCsv'),
          exportXlsx: t('exportXlsx'),
          exportPdf: t('exportPdf'),
          exportDocx: t('exportDocx'),
          exportHint: t('exportHint'),
          dragHint: t('dragHint'),
        }}
      />
    </div>
  );
}
