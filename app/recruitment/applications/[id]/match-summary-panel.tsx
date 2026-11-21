'use client';
import { useState, useTransition } from 'react';
import type { RecruitmentMatchSummary } from '@/packs/recruitment/service';
import { suggestMatchSummaryAction } from '../../actions';

export type MatchSummaryLabels = {
  title: string; note: string; ask: string; asking: string; again: string; matches: string; gaps: string; questions: string; none: string;
  disclaimer: string; fields: string; fieldNames: Record<string, string>; problems: Record<string, string>;
};

/**
 * Slice 24: "Suggest a match summary" on the application's Candidate tab, for the job's reviewers while the company's switch is on
 * and the owner has approved the provider data. The reply is shown here only, to this person, and is never stored: what the job asks
 * for that the recorded history appears to meet, what it does not show, and questions to ask. It never ranks, scores or decides.
 */
export function MatchSummaryPanel({ applicationId, labels }: { applicationId: string; labels: MatchSummaryLabels }) {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<RecruitmentMatchSummary | null>(null);
  const [problem, setProblem] = useState<{ text: string; fields: string[] } | null>(null);
  const ask = () => start(async () => {
    setProblem(null);
    const result = await suggestMatchSummaryAction(applicationId).catch(() => ({ problem: 'unexpected' }) as const);
    if ('summary' in result) { setSummary(result.summary); return; }
    setSummary(null);
    setProblem({ text: labels.problems[result.problem] ?? labels.problems.unexpected, fields: 'fields' in result && result.fields ? result.fields : [] });
  });
  const list = (heading: string, items: readonly string[]) => (
    <div className="min-w-0 space-y-1">
      <h4 className="text-sm font-medium">{heading}</h4>
      {items.length === 0 ? <p className="text-sm text-muted-foreground">{labels.none}</p> : (
        <ul className="list-disc space-y-1 pl-5 text-sm">{items.map((item, i) => <li key={i} className="break-words">{item}</li>)}</ul>
      )}
    </div>
  );
  return (
    <section aria-labelledby="match-summary-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id="match-summary-title" className="text-base font-semibold">{labels.title}</h3>
          <p className="max-w-3xl text-xs text-muted-foreground">{labels.note}</p>
        </div>
        <button type="button" onClick={ask} disabled={pending} aria-busy={pending}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60">
          {pending ? labels.asking : summary ? labels.again : labels.ask}
        </button>
      </div>
      {problem && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <p>{problem.text}</p>
          {problem.fields.length > 0 && (
            <p className="mt-1 text-xs">{labels.fields} {problem.fields.map((f) => labels.fieldNames[f] ?? f).join(', ')}</p>
          )}
        </div>
      )}
      {summary && (
        <div className="space-y-3" aria-live="polite">
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{labels.disclaimer}</p>
          <div className="grid gap-4 md:grid-cols-3">
            {list(labels.matches, summary.matches)}
            {list(labels.gaps, summary.gaps)}
            {list(labels.questions, summary.questions)}
          </div>
        </div>
      )}
    </section>
  );
}
