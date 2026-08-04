import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { countNoticeAudience, getNotice } from '@/core/notice';
import { Card, ErrorBanner, PageHeader, SectionHeader, StatusBadge, btnGhost } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { NoticeForm } from '@/components/notice/notice-form';
import { criteriaVocabulary } from '../criteria-options';
import {
  archiveNoticeAction,
  deleteNoticeAction,
  duplicateNoticeAction,
  publishNoticeAction,
  restoreNoticeAction,
  updateNoticeAction,
} from '../actions';

/**
 * 6e122302 — Admin → Notice Board → one notice: the setup form, the reach, and the lifecycle buttons.
 *
 * ── THE REACH BOX IS THE POINT OF THIS PAGE ────────────────────────────────────────────────────────────
 * A draft shows how many employees its SAVED criteria resolve to right now, computed on the server by the
 * same resolver the publish will run, immediately above the publish button — and the publish confirmation
 * repeats the number. An empty criteria set legitimately means everyone, and the resolver refuses to
 * second-guess an explicit request, so this number is the only thing standing between "I did not finish
 * the audience step" and a company-wide broadcast.
 *
 * A PUBLISHED notice shows the SNAPSHOT size instead — who it actually reached, not who it would reach if
 * you ran the criteria again today. Those two numbers legitimately differ the moment anyone joins, leaves
 * or transfers, and showing the live figure on a published notice would quietly rewrite history.
 *
 * ONE i18n NAMESPACE (`notices`); the criteria vocabulary's other namespaces live in ../criteria-options.ts.
 */
export default async function NoticeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('notices');
  const { id } = await params;
  const { error } = await searchParams;

  const n = await getNotice(s, id);
  if (!n) notFound();

  const vocab = await criteriaVocabulary(s);
  const published = n.publishedAt != null;
  // Only a draft needs a projection — a published notice HAS an audience, and re-resolving it would answer
  // a different question from the one the reader is asking.
  const projected = published
    ? null
    : await countNoticeAudience(s, { criteria: n.targetMode === 'individual' ? {} : n.criteria });
  const reach = published
    ? n.recipientCount
    : n.targetMode === 'individual'
      ? (n.criteria.employmentIds ?? []).length
      : (projected?.count ?? 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={n.title}
        description={<StatusBadge status={n.status} label={t(`status.${n.status}`)} />}
        back={{ href: '/admin/notice-board', label: t('backToBoard') }}
      />
      <ErrorBanner message={error} />

      {/* ── Reach + lifecycle ──────────────────────────────────────────────────────────────────────── */}
      <Card>
        <SectionHeader title={t('reachTitle')} />
        <div className="space-y-3 px-4 py-3">
          <p className="text-sm">
            {published ? t('reachPublished', { count: reach }) : t('reachDraft', { count: reach })}
          </p>
          {!published && projected?.unrestricted && n.targetMode === 'criteria' && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t('everyoneWarning')}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {!published && !n.archivedAt && (
              <form action={publishNoticeAction}>
                <input type="hidden" name="id" value={n.id} />
                {/* Publishing is the irreversible act in this module: it resolves and freezes the audience
                    and (optionally) notifies every one of them. So it asks first, and the question names
                    the number. */}
                <ConfirmSubmit
                  size="sm"
                  title={t('publishConfirmTitle')}
                  description={t('publishConfirmDescription', { count: reach })}
                >
                  {t('publish')}
                </ConfirmSubmit>
              </form>
            )}
            {!n.archivedAt && (
              <form action={archiveNoticeAction}>
                <input type="hidden" name="id" value={n.id} />
                <ConfirmSubmit
                  size="sm"
                  variant="outline"
                  title={t('archiveConfirmTitle')}
                  description={t('archiveConfirmDescription')}
                >
                  {t('archive')}
                </ConfirmSubmit>
              </form>
            )}
            {n.archivedAt && (
              <form action={restoreNoticeAction}>
                <input type="hidden" name="id" value={n.id} />
                <button type="submit" className={btnGhost}>
                  {t('restore')}
                </button>
              </form>
            )}
            <form action={duplicateNoticeAction}>
              <input type="hidden" name="id" value={n.id} />
              <button type="submit" className={btnGhost}>
                {t('duplicate')}
              </button>
            </form>
            {/* Delete is offered ONLY for a draft. A published notice was broadcast to people; deleting it
                would erase the fact that the announcement was made. The service refuses it too — this is
                the UX half of that rule, not the enforcement. */}
            {!published && (
              <form action={deleteNoticeAction}>
                <input type="hidden" name="id" value={n.id} />
                <ConfirmSubmit
                  size="sm"
                  variant="destructive"
                  title={t('deleteConfirmTitle')}
                  description={t('deleteConfirmDescription')}
                >
                  {t('delete')}
                </ConfirmSubmit>
              </form>
            )}
          </div>
        </div>
      </Card>

      {/* ── The setup form ─────────────────────────────────────────────────────────────────────────── */}
      <Card>
        <SectionHeader title={t('setupTitle')} />
        <div className="px-4 pb-4 pt-3">
          <NoticeForm
            action={updateNoticeAction}
            values={{
              title: n.title,
              body: n.body,
              startOn: n.startOn,
              endOn: n.endOn,
              showEndDate: n.showEndDate,
              targetMode: n.targetMode,
              criteria: n.criteria as Record<string, string[] | undefined>,
              employmentIds: n.criteria.employmentIds ?? [],
              notifyOnPublish: n.notifyOnPublish,
              popupEnabled: n.popupEnabled,
              popupFrequency: n.popupFrequency,
            }}
            idField={n.id}
            companies={vocab.companies}
            departments={vocab.departments}
            employmentTypes={vocab.employmentTypes}
            orgCriteria={vocab.orgCriteria}
            targetingFrozen={published}
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
              submit: t('save'),
            }}
          />
        </div>
      </Card>
    </div>
  );
}
