/** Server-only presentation copy for the human own-leave candidate panel. */
import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { OwnLeaveCommandMessages } from './own-leave-command-panel';

export async function ownLeaveCommandCopy(): Promise<OwnLeaveCommandMessages> {
  const t = await getTranslations('ownLeaveReview.commands');
  return Object.freeze({
    employment: t('employment'),
    leaveType: t('leaveType'),
    chooseEmployment: t('chooseEmployment'),
    chooseLeaveType: t('chooseLeaveType'),
    date: t('date'),
    reason: t('reason'),
    remark: t('remark'),
    prepare: t('prepare'),
    preparing: t('preparing'),
    confirm: t('confirm'),
    confirming: t('confirming'),
    discard: t('discard'),
    discarding: t('discarding'),
    checking: t('checking'),
    reopen: t('reopen'),
    explanation: t('explanation'),
    confirmNote: t('confirmNote'),
    uncertain: t('uncertain'),
    prepareUncertain: t('prepareUncertain'),
    submitted: t('submitted'),
    submittedNote: t('submittedNote'),
    discarded: t('discarded'),
    expired: t('expired'),
    refused: t('refused'),
    unavailable: t('unavailable'),
    invalidSelection: t('invalidSelection'),
    needsRemark: t('needsRemark'),
    openRequests: t('openRequests'),
    findReviews: t('findReviews'),
    findingReviews: t('findingReviews'),
    savedReviews: t('savedReviews'),
    noSavedReviews: t('noSavedReviews'),
    openSavedReview: t('openSavedReview'),
    indexLimitNote: t('indexLimitNote'),
    savedPending: t('savedPending'),
    savedCompleted: t('savedCompleted'),
    savedDiscarded: t('savedDiscarded'),
    savedExpired: t('savedExpired'),
    savedRefused: t('savedRefused'),
    savedCreated: t('savedCreated'),
    savedExpires: t('savedExpires'),
  });
}
