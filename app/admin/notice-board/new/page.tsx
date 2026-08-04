import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { NoticeForm } from '@/components/notice/notice-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { criteriaVocabulary } from '../criteria-options';
import { createNoticeAction } from '../actions';

/**
 * 6e122302 — Admin → Notice Board → Add New Notice.
 *
 * Creating SAVES A DRAFT. It does not publish, and there is no "create and publish" shortcut: publishing
 * resolves and freezes the audience, and that is not a thing to do as a side effect of pressing Save on a
 * form you have not yet seen the reach of. The draft's own page shows how many employees the saved
 * criteria resolve to, and the publish button lives there, next to that number.
 *
 * SERVER COMPONENT — everything interactive is in NoticeForm, which receives only serialisable props
 * (r124's lesson; test/server-client-boundary.test.ts pins it).
 *
 * ONE i18n NAMESPACE (`notices`) so check C covers every key on this page; the criteria vocabulary's three
 * namespaces are isolated in ../criteria-options.ts. See that file's header for why.
 */
export default async function NewNoticePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('notices');
  const { error } = await searchParams;
  const vocab = await criteriaVocabulary(s);
  const today = todayInKualaLumpur();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t('newTitle')}
        description={t('newDescription')}
        back={{ href: '/admin/notice-board', label: t('backToBoard') }}
      />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('setupTitle')} />
        <div className="px-4 pb-4 pt-3">
          <NoticeForm
            action={createNoticeAction}
            values={{
              title: '',
              body: '',
              startOn: today,
              endOn: today,
              showEndDate: false,
              targetMode: 'criteria',
              criteria: {},
              employmentIds: [],
              notifyOnPublish: false,
              popupEnabled: false,
              popupFrequency: 'once',
            }}
            companies={vocab.companies}
            departments={vocab.departments}
            employmentTypes={vocab.employmentTypes}
            orgCriteria={vocab.orgCriteria}
            targetingFrozen={false}
            labels={{
              sectionBasics: t('sectionBasics'),
              sectionContent: t('sectionContent'),
              sectionAudience: t('sectionAudience'),
              sectionDelivery: t('sectionDelivery'),
              fTitle: t('fTitle'),
              fStartOn: t('fStartOn'),
              fEndOn: t('fEndOn'),
              fShowEndDate: t('fShowEndDate'),
              fBody: t('fBody'),
              fBodyHelp: t('fBodyHelp'),
              write: t('write'),
              preview: t('preview'),
              previewEmpty: t('previewEmpty'),
              byCriteria: t('byCriteria'),
              byIndividual: t('byIndividual'),
              companies: t('fCompanies'),
              departments: t('fDepartments'),
              employmentTypes: t('fEmploymentTypes'),
              employmentIds: t('fEmploymentIds'),
              employmentIdsHelp: t('fEmploymentIdsHelp'),
              everyoneWarning: t('everyoneWarning'),
              targetingFrozen: t('targetingFrozen'),
              fNotify: t('fNotify'),
              fNotifyHelp: t('fNotifyHelp'),
              fPopup: t('fPopup'),
              fPopupFrequency: t('fPopupFrequency'),
              popupOnce: t('popupOnce'),
              popupUntilAcknowledged: t('popupUntilAcknowledged'),
              submit: t('saveDraft'),
            }}
          />
        </div>
      </Card>
    </div>
  );
}
