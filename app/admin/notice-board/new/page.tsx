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
            /* r288 — the audience step's picker, read once in ../criteria-options.ts and handed over as
               PLAIN DATA: no functions cross this boundary (test/server-client-boundary.test.ts). */
            employees={vocab.employees}
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
              employeePicker: t('fEmployeePicker'),
              employeeNoneChosen: t('fEmployeeNoneChosen'),
              employeeSearch: t('fEmployeeSearch'),
              /* ⚠️ THE THREE TEMPLATES PASS THEIR OWN PLACEHOLDER BACK IN, and that is not a trick — it
                 is the app/admin/personnel/[employmentId]/page.tsx idiom. These messages carry an ICU
                 variable that `NoticeForm` substitutes on the CLIENT side of the boundary (it has a
                 string, not a translator). A bare `t('fEmployeeNoMatch')` does not return the raw
                 message: next-intl FORMATS it, finds no `query`, throws FORMATTING_ERROR and renders
                 the KEY PATH — a 200 with "notices.fEmployeeNoMatch" in the popover. Found by rendering
                 this page on a dev server and reading the log; tsc, eslint and every jsdom guard were
                 green, because a jsdom guard builds these labels straight out of messages/en.json and
                 never goes through next-intl at all (CLAUDE.md §8: a 200 is not a render check).
                 `t.raw()` would also work but would take these keys out of i18n check C's sight. */
              employeeNoMatchTemplate: t('fEmployeeNoMatch', { query: '{query}' }),
              employeeNonePicked: t('fEmployeeNonePicked'),
              employeeSelectedCountTemplate: t('fEmployeeSelectedCount', { count: '{count}' }),
              employeeSelectAll: t('fEmployeeSelectAll'),
              employeeClearAll: t('fEmployeeClearAll'),
              employeeRemoveTemplate: t('fEmployeeRemove', { name: '{name}' }),
              pasteAlternative: t('fPasteAlternative'),
              pasteAlternativeHelp: t('fPasteAlternativeHelp'),
              /* r289 — a FOURTH template, and it passes its own placeholder back in for exactly the
                 reason the three above do: a bare `t('fPasteUnmatched')` would find no `list`, throw
                 FORMATTING_ERROR and render the key path behind a green 200. */
              pasteUnmatchedTemplate: t('fPasteUnmatched', { list: '{list}' }),
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
