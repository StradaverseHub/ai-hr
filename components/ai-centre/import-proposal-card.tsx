import { getFormatter, getTranslations } from 'next-intl/server';
import { FileSpreadsheet } from 'lucide-react';
import type { Proposal } from '@/core/proposals/proposal';
import { ProposalCard, type ProposalCheck } from './proposal-card';
import { ImportProposalActions } from './import-proposal-actions';

/** AI v2 Phase 1, slice 3 (issue 16b) — the prepared import card (approved mock-up Ask.dc.html: "211 rows ready, 3 need
 * attention", "Confirm 211 rows", "Fix the 3 rows").
 *
 * The one proposal card (./proposal-card.tsx), rendered from the signed proposal the import preparer issued this turn
 * (core/proposals/chat-import.ts): the kind, the company, the rows ready and the rows needing attention, and the first
 * few of those by row number, column and a plain reason in the person's language (never a cell value: the import page's
 * own preview shows every row). Its buttons (./import-proposal-actions.tsx) confirm through the import owner, or open the
 * import page with the file handed over. */
export async function ImportProposalCard({ proposal }: { proposal: Proposal }) {
  const t = await getTranslations('chatImport');
  const tc = await getTranslations('aiCentre.conversation');
  const format = await getFormatter();
  const body = proposal.body, summary = body.import!;
  const checks: ProposalCheck[] = [{ label: t('ready', { count: summary.ready }), tone: 'ok' },
    ...(summary.attention > 0 ? [{ label: t('attention', { count: summary.attention }), tone: 'warn' as const }] : [])];
  const notes = [
    !summary.confirmable && summary.ready > 0 ? t('allRowsFirst') : null,
    summary.otherCompany > 0 ? t('otherCompany', { count: summary.otherCompany }) : null,
    summary.replacing > 0 ? t('replacing', { count: summary.replacing }) : null,
    summary.warned > 0 ? t('warned', { count: summary.warned }) : null,
    summary.revertible ? t('noteRevert') : t('note'),
  ].filter((line): line is string => Boolean(line));
  const more = summary.issueCount - summary.issues.length;
  const expires = tc('expires', { time: format.dateTime(new Date(body.expiresAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) });
  return (
    <div data-chat-import-card={summary.kind}>
      <ProposalCard icon={<FileSpreadsheet />} tone="prepared" awaitingLabel={(await getTranslations('aiCentre.card'))('awaiting')}
        title={t('title', { kind: t(`kinds.${summary.kind}`), company: summary.company, count: summary.total })}
        meta={[t('prepared')]} checks={checks} expires={expires}
        actions={<div className="space-y-3">
          {summary.issues.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[20rem] border-collapse text-left text-sm">
                <caption className="sr-only">{t('issuesLabel')}</caption>
                <thead className="text-xs text-muted-foreground">
                  <tr><th scope="col" className="px-3 py-2 font-medium">{t('row')}</th><th scope="col" className="px-3 py-2 font-medium">{t('column')}</th><th scope="col" className="px-3 py-2 font-medium">{t('issue')}</th></tr>
                </thead>
                <tbody>
                  {summary.issues.map((issue, index) => (
                    <tr key={index} className="border-t border-border">
                      <td className="px-3 py-2 tabular-nums">{issue.row === 0 ? t('header') : issue.row}</td>
                      <td className="px-3 py-2 font-mono text-xs">{issue.field === 'row' ? '—' : issue.field}</td>
                      <td className="px-3 py-2">{t(`reasons.${issue.reason}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more > 0 && <p className="text-xs text-muted-foreground">{t('more', { count: more })}</p>}
          <ImportProposalActions proposal={proposal} />
          <ul className="space-y-1 text-xs text-muted-foreground">{notes.map(line => <li key={line}>{line}</li>)}</ul>
        </div>} />
    </div>
  );
}
