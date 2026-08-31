import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { proposeActions } from '@/core/agent-actions';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnPrimary,
  pageWideCls,
} from '@/components/ui';
import { approveAgentActionAction } from './actions';

/**
 * ADR-0083 §2.5 — the approval screen. The first place in this product where a person authorises an
 * agent to WRITE.
 *
 * THE PAGE'S JOB IS TO MAKE APPROVAL AN INFORMED ACT, NOT A CONVENIENT ONE. It shows the reasoning, not
 * just the conclusion: who, which check fired, and the record fact that has since been filled in. An
 * operator who cannot check the claim is not approving, they are rubber-stamping — and a rubber stamp on
 * a write is exactly what the human gate exists to prevent. So the row carries the evidence and the
 * button carries only the verdicts printed above it.
 *
 * WHAT IT SAYS OUT LOUD, because each is a property somebody should not have to read the source to learn:
 *   · nothing here has happened, and nothing will until a person presses the button;
 *   · the write is a judgement stamp, not a change to anybody's data, and re-checking the run supersedes it;
 *   · one approval is capped, and when there are more than the cap it says so rather than quietly doing
 *     a subset;
 *   · the condition is re-tested when you press it, so anything fixed-then-unfixed in between is skipped
 *     rather than closed.
 *
 * AN EMPTY LIST IS THE HEALTHY STATE AND IS RENDERED AS ONE — r234's lesson from the readiness screen. A
 * page that looks identical whether it found nothing or ran nothing teaches an operator to distrust it.
 */
export default async function AgentActionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; closed?: string; stale?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('controlTower.actions');
  // The detector's own name, from the vocabulary the exceptions queue already owns. Naming the same check
  // two different ways on two screens is how an operator stops believing either of them.
  const tAnomaly = await getTranslations('anomaly');
  const sp = await searchParams;
  const proposals = await proposeActions(s);

  const closed = Number(sp.closed ?? 0);
  const stale = Number(sp.stale ?? 0);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('title')}
        description={t('description')}
        back={{ href: '/control-tower', label: t('backToTower') }}
      />
      <ErrorBanner message={sp.error ? t(`error.${sp.error}`) : undefined} />

      {sp.closed !== undefined && (
        <Card className="p-4">
          <p className="text-sm">{t('done', { closed })}</p>
          {stale > 0 && (
            // Not an error, and said in its own words: the re-check did its job, and saying nothing about
            // it would leave the operator to discover a discrepancy in the count on their own.
            <p className="mt-1 text-xs text-muted-foreground">{t('staleNote', { stale })}</p>
          )}
        </Card>
      )}

      {proposals.length === 0 ? (
        <Card className="p-6">
          <p className="font-medium">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
        </Card>
      ) : (
        proposals.map((p) => (
          <Card key={p.type.id} className="overflow-hidden">
            <SectionHeader title={t(`type.${p.type.id}`)} count={p.count} subtitle={t(`does.${p.type.id}`)} />
            <div className="p-4">
              <p className="text-xs text-muted-foreground">{t('reversibleNote')}</p>

              <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                {p.subjects.map((sub) => (
                  <li key={sub.verdictId} className="px-3 py-2 text-sm">
                    <p className="font-medium">{sub.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {/* The reasoning, in one line: what fired, and why it no longer holds. */}
                      {tAnomaly(`detector.${camel(sub.detectorId)}`)} · {t(`cause.${sub.cause}`)}
                    </p>
                  </li>
                ))}
              </ul>

              {p.overCap && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  {t('overCap', { cap: p.type.blastRadiusCap, total: p.count })}
                </p>
              )}

              <form action={approveAgentActionAction} className="mt-4">
                <input type="hidden" name="typeId" value={p.type.id} />
                {/* ONLY WHAT IS ON SCREEN CAN BE APPROVED. Posting a filter instead of ids would let a row
                    that appeared between render and click ride along on an approval nobody gave it. */}
                {p.subjects.slice(0, p.type.blastRadiusCap).map((sub) => (
                  <input key={sub.verdictId} type="hidden" name="verdictId" value={sub.verdictId} />
                ))}
                <button type="submit" className={btnPrimary}>
                  {t('approve', { n: Math.min(p.subjects.length, p.type.blastRadiusCap) })}
                </button>
                <p className="mt-2 text-xs text-muted-foreground">{t('recheckNote')}</p>
              </form>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

/** `missing-bank-profile` → `missingBankProfile`, the shape the `anomaly.detector.*` keys are stored in. */
const camel = (id: string) => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
