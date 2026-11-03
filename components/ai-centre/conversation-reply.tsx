import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import type { ConversationTurn } from '@/core/teras-wiring/turn';
import { ruleVersionLabel } from '@/lib/ai-centre/rule-version';
import { leaveApplyCardTitle, LEAVE_APPLY_TITLE_DATE } from '@/lib/ai-centre/leave-apply-title';
import { attendanceRequestCardTitle, ATTENDANCE_TITLE_DATE, ATTENDANCE_TITLE_TIME } from '@/lib/ai-centre/attendance-request-title';
import { ownChangeCardTitle, OWN_CHANGE_TITLE_DATE } from '@/lib/ai-centre/own-change-title';
import { toilRequestCardTitle } from '@/lib/ai-centre/toil-request-title';
import { assignedDecisionCardTitle } from '@/lib/ai-centre/assigned-decision-title';
import { ProposalCard, type ProposalCheck } from './proposal-card';
import { InlineProposalCard } from './proposal-card-actions';
import { inlineProposalKind, type InlineProposalCopy } from '@/lib/ai-centre/inline-proposal';
import { RecommendationPanel } from './leave-recommendation';
import { ConversationSuggestions } from '@/components/assistant/chat-reply-boundary';
import { ReplyMarkdown, type ReplyLinks } from './reply-markdown';
import { ImportProposalCard } from './import-proposal-card';
import { CHAT_IMPORT_ACTION } from '@/lib/chat-import';

/** Reads that have a "Why?" explainer the person can ask for next (ADR-0170 step 4). */
const WHY: Readonly<Record<string, string>> = { my_leave_balances: 'leave', my_payslip_summary: 'payslip' };
const words = (value: string) => value.replace(/[._]+/g, ' ').trim();

/** A live-chat reply from a Noveri conversation turn, rendered like the AI centre's Ask (ADR-0170 §11.3 change 1).
 *
 * Every value comes from the turn the harness ran as this person: the reply with names and figures already
 * restored for them alone, the cards the native preparers signed this turn (each verified for this caller), the
 * reads it used and the sensitive-topic route. A card for the person's own leave application, attendance request,
 * claim or profile change carries Confirm, Edit and Discard (AI v2 Phase 1, ./proposal-card-actions.tsx): Confirm
 * posts the signed card to its owner, which verifies it for this caller and checks everything again; nothing posts
 * without a press. Every other card only links to its review page, where the person confirms. The approver recommendation
 * shows only "recommend approve" or "needs your review", never a rejection. Awaited by the chat command, like the
 * closed grammar's ExchangeReply. */
export async function ConversationReply({ turn, links = new Map() }: { turn: ConversationTurn; links?: ReplyLinks }) {
  const t = await getTranslations('aiCentre.conversation');
  const tc = await getTranslations('aiCentre.card');
  const tr = await getTranslations('aiCentre.recommendation');
  // AI v2 W2 slice 2: the Leave Credit form's own First Schedule agreement sentence, reused word for word on the card.
  const tLeaveCredit = await getTranslations('replacementRequest');
  const format = await getFormatter();
  // The internal rule reference never reaches the screen: only the kind of rule and its version number.
  const version = (reference: string | null) => { const known = ruleVersionLabel(reference); return known ? tr(`version.${known.kind}`, { version: known.version }) : undefined; };
  const label = (group: string, key: string, fallback: string) => (t.has(`${group}.${key}`) ? t(`${group}.${key}`) : fallback);
  const reads = [...new Set(turn.reads)].map(name => label('reads', name, words(name)));
  const why = [...new Set(turn.reads.map(name => WHY[name]).filter((key): key is string => Boolean(key)))]
    .map(key => ({ label: t(`why.${key}`), prompt: t(`why.${key}Prompt`) }));
  const routed = turn.sensitive || turn.crisis;
  const inline: InlineProposalCopy = {
    confirm: t('inline.confirm'), confirming: t('inline.confirming'), edit: t('inline.edit'), opening: t('inline.opening'),
    discard: t('inline.discard'), actionsLabel: t('inline.actionsLabel'), confirmedBy: t('inline.confirmedBy'),
    openClaims: t('inline.openClaims'), fixIt: t('inline.fixIt'), error: t('inline.error'),
    done: { leaveSubmitted: t('inline.done.leaveSubmitted'), attendanceSubmitted: t('inline.done.attendanceSubmitted'),
      claimSubmitted: t('inline.done.claimSubmitted'), claimDraftSaved: t('inline.done.claimDraftSaved'),
      claimCancelled: t('inline.done.claimCancelled'), profileRequested: t('inline.done.profileRequested'),
      toilSubmitted: t('inline.done.toilSubmitted'),
      decisionApproved: t('inline.done.decisionApproved'), decisionRejected: t('inline.done.decisionRejected'),
      decisionLevelRecorded: t('inline.done.decisionLevelRecorded') },
    refused: { expired: t('inline.refused.expired'), invalid: t('inline.refused.invalid'), access: t('inline.refused.access'),
      retired: t('inline.refused.retired'), unavailable: t('inline.refused.unavailable'), consent: t('inline.refused.consent') },
  };
  // AI v2 slice 3 (issue 16b): an import prepared in chat has its own card (./import-proposal-card.tsx), rendered first.
  const importCards = new Map(await Promise.all(turn.proposals.filter(proposal => proposal.body.what.action === CHAT_IMPORT_ACTION && proposal.body.import)
    .map(async proposal => [proposal.body.id, await ImportProposalCard({ proposal })] as const)));
  return (
    <div data-teras-reply={turn.turnId} className="space-y-3">
      {routed && (
        <aside role="note" data-teras-route={turn.crisis ? 'crisis' : 'hr_contact'}
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 flex-none" />
          {/* AI v2 W11: emergency help first on a crisis turn, then the protected case route where it is set up. The
              person writes the case on its own form; nothing of this turn is passed to it. */}
          <span className="min-w-0 space-y-1">
            <span className="block">{t(turn.crisis ? 'routedCrisis' : 'routed')}</span>
            {turn.caseRoute && (
              <Link href={turn.caseRoute} data-teras-case-route
                className="inline-flex items-center font-medium text-primary underline underline-offset-2 hover:no-underline pointer-coarse:min-h-11">
                {t('startPrivateCase')}
              </Link>
            )}
          </span>
        </aside>
      )}
      {turn.reply && <ReplyMarkdown text={turn.reply} links={links} />}
      {turn.proposals.map(proposal => {
        if (importCards.has(proposal.body.id)) return <div key={proposal.body.id}>{importCards.get(proposal.body.id)}</div>;
        const body = proposal.body, facts = body.facts ?? {};
        const checks: ProposalCheck[] = body.checks.map(check => ({ label: label('checks', check.check, words(check.check)),
          tone: check.result === 'pass' ? 'ok' : 'warn', ruleVersion: version(check.ruleVersion) }));
        const meta = [facts.leaveType, facts.startDate && (facts.endDate && facts.endDate !== facts.startDate ? `${facts.startDate} – ${facts.endDate}` : facts.startDate),
          typeof facts.days === 'number' ? t('days', { count: facts.days }) : undefined,
          // AI v2 W2 slice 2: the leave service's own count of a Leave Credit, never a figure the model gave.
          typeof facts.creditDays === 'number' ? t('creditDays', { count: facts.creditDays }) : undefined,
          facts.outcome ? label('outcomes', facts.outcome, words(facts.outcome)) : undefined].filter((line): line is string => Boolean(line));
        const recommendation = body.recommendation;
        // Issue 10: a leave application names its own type, dates and days; every other card keeps its action title.
        const title = leaveApplyCardTitle(body, (key, values) => t(key, values), date => format.dateTime(date, LEAVE_APPLY_TITLE_DATE))
          // AI v2 W2: an attendance correction or overtime card names its day and times.
          ?? attendanceRequestCardTitle(body, (key, values) => t(key, values), date => format.dateTime(date, ATTENDANCE_TITLE_DATE), time => format.dateTime(time, ATTENDANCE_TITLE_TIME))
          // AI v2 W2: an own claim or profile change names its type, amount and date, or what changes.
          ?? ownChangeCardTitle(body, (key, values) => t(key, values), date => format.dateTime(date, OWN_CHANGE_TITLE_DATE))
          // AI v2 W2 slice 2: a Leave Credit request names its date worked and window.
          ?? toilRequestCardTitle(body, (key, values) => t(key, values), date => format.dateTime(date, ATTENDANCE_TITLE_DATE), time => format.dateTime(time, ATTENDANCE_TITLE_TIME))
          // AI v2 W2 slice 3: an assigned approver's decision names the decision and the request it decides.
          ?? assignedDecisionCardTitle(body, (key, values) => t(key, values), { claimDate: date => format.dateTime(date, OWN_CHANGE_TITLE_DATE),
            day: date => format.dateTime(date, ATTENDANCE_TITLE_DATE), time: time => format.dateTime(time, ATTENDANCE_TITLE_TIME) })
          ?? label('actions', body.what.action.replace(/\./g, '_'), t('actions.fallback'));
        const tone = body.what.effect === 'decide' ? 'decide' as const : 'prepared' as const;
        const expires = t('expires', { time: format.dateTime(new Date(body.expiresAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) });
        const kind = inlineProposalKind(body.what.action);
        // The leave service decided, when the card was prepared, that the person's own First Schedule agreement is asked for.
        const agreement = kind === 'toil' && body.what.selectors.firstScheduleAgreement === 'required' ? { label: tLeaveCredit('firstScheduleConsent') } : undefined;
        return (
          <div key={body.id} className="space-y-1">
            {kind ? (
              <InlineProposalCard kind={kind} proposal={proposal} copy={inline} awaitingLabel={tc('awaiting')} agreement={agreement}
                card={{ icon: <CalendarDays />, tone, title, meta, checks, expires,
                  prepared: { summary: t('howPrepared'), rows: [[t('preparedBy'), t('preparedByValue')], [t('confirmOn'), t('inline.confirmOnValue')]] } }} />
            ) : (
              <ProposalCard icon={<CalendarDays />} tone={tone}
                title={title} meta={meta} checks={checks}
                href={body.review.href} cta={t('review')} expires={expires}
                prepared={{ summary: t('howPrepared'), rows: [[t('preparedBy'), t('preparedByValue')], [t('confirmOn'), t('confirmOnValue')]] }} />
            )}
            {recommendation && <RecommendationPanel view={{ kind: 'recommendation', verdict: recommendation.verdict,
              failedRules: recommendation.failedRules.map(rule => ({ check: rule.check, blocking: rule.blocking, version: ruleVersionLabel(rule.ruleVersion) })) }} />}
          </div>
        );
      })}
      {turn.suggestion && turn.proposals.length === 0 && (
        <ProposalCard icon={<CalendarDays />} tone="finding" title={label('actions', turn.suggestion.action.replace(/\./g, '_'), t('actions.fallback'))}
          meta={[t('suggestionMeta')]} href={turn.suggestion.reviewRoute} cta={t('open')} />
      )}
      {reads.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('readAs', { reads: format.list(reads, { type: 'conjunction' }) })}{' '}
          <Link href="/assistant?view=how" className="text-primary hover:underline">{t('howAnswers')}</Link>
        </p>
      )}
      {why.length > 0 && <ConversationSuggestions suggestions={why} label={t('whyLabel')} />}
    </div>
  );
}
