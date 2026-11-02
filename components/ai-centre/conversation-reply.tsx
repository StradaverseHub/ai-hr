import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import type { ConversationTurn } from '@/core/teras-wiring/turn';
import { ruleVersionLabel } from '@/lib/ai-centre/rule-version';
import { leaveApplyCardTitle, LEAVE_APPLY_TITLE_DATE } from '@/lib/ai-centre/leave-apply-title';
import { ProposalCard, type ProposalCheck } from './proposal-card';
import { RecommendationPanel } from './leave-recommendation';
import { ConversationSuggestions } from '@/components/assistant/chat-reply-boundary';
import { ReplyMarkdown, type ReplyLinks } from './reply-markdown';

/** Reads that have a "Why?" explainer the person can ask for next (ADR-0170 step 4). */
const WHY: Readonly<Record<string, string>> = { my_leave_balances: 'leave', my_payslip_summary: 'payslip' };
const words = (value: string) => value.replace(/[._]+/g, ' ').trim();

/** A live-chat reply from a Noveri conversation turn, rendered like the AI centre's Ask (ADR-0170 §11.3 change 1).
 *
 * Every value comes from the turn the harness ran as this person: the reply with names and figures already
 * restored for them alone, the cards the native preparers signed this turn (each verified for this caller), the
 * reads it used and the sensitive-topic route. A card only links to its review page, where the person confirms
 * and the owning service checks everything again; nothing here completes a change. The approver recommendation
 * shows only "recommend approve" or "needs your review", never a rejection. Awaited by the chat command, like the
 * closed grammar's ExchangeReply. */
export async function ConversationReply({ turn, links = new Map() }: { turn: ConversationTurn; links?: ReplyLinks }) {
  const t = await getTranslations('aiCentre.conversation');
  const tr = await getTranslations('aiCentre.recommendation');
  const format = await getFormatter();
  // The internal rule reference never reaches the screen: only the kind of rule and its version number.
  const version = (reference: string | null) => { const known = ruleVersionLabel(reference); return known ? tr(`version.${known.kind}`, { version: known.version }) : undefined; };
  const label = (group: string, key: string, fallback: string) => (t.has(`${group}.${key}`) ? t(`${group}.${key}`) : fallback);
  const reads = [...new Set(turn.reads)].map(name => label('reads', name, words(name)));
  const why = [...new Set(turn.reads.map(name => WHY[name]).filter((key): key is string => Boolean(key)))]
    .map(key => ({ label: t(`why.${key}`), prompt: t(`why.${key}Prompt`) }));
  const routed = turn.sensitive || turn.crisis;
  return (
    <div data-teras-reply={turn.turnId} className="space-y-3">
      {routed && (
        <aside role="note" data-teras-route={turn.crisis ? 'crisis' : 'hr_contact'}
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 flex-none" />
          <span>{t(turn.crisis ? 'routedCrisis' : 'routed')}</span>
        </aside>
      )}
      {turn.reply && <ReplyMarkdown text={turn.reply} links={links} />}
      {turn.proposals.map(proposal => {
        const body = proposal.body, facts = body.facts ?? {};
        const checks: ProposalCheck[] = body.checks.map(check => ({ label: label('checks', check.check, words(check.check)),
          tone: check.result === 'pass' ? 'ok' : 'warn', ruleVersion: version(check.ruleVersion) }));
        const meta = [facts.leaveType, facts.startDate && (facts.endDate && facts.endDate !== facts.startDate ? `${facts.startDate} – ${facts.endDate}` : facts.startDate),
          typeof facts.days === 'number' ? t('days', { count: facts.days }) : undefined,
          facts.outcome ? label('outcomes', facts.outcome, words(facts.outcome)) : undefined].filter((line): line is string => Boolean(line));
        const recommendation = body.recommendation;
        // Issue 10: a leave application names its own type, dates and days; every other card keeps its action title.
        const title = leaveApplyCardTitle(body, (key, values) => t(key, values), date => format.dateTime(date, LEAVE_APPLY_TITLE_DATE))
          ?? label('actions', body.what.action.replace(/\./g, '_'), t('actions.fallback'));
        return (
          <div key={body.id} className="space-y-1">
            <ProposalCard icon={<CalendarDays />} tone={body.what.effect === 'decide' ? 'decide' : 'prepared'}
              title={title} meta={meta} checks={checks}
              href={body.review.href} cta={t('review')}
              expires={t('expires', { time: format.dateTime(new Date(body.expiresAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) })}
              prepared={{ summary: t('howPrepared'), rows: [[t('preparedBy'), t('preparedByValue')], [t('confirmOn'), t('confirmOnValue')]] }} />
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
