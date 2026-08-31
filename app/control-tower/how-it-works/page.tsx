import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { agentStatuses, domainsFor } from '@/core/control-domains';
import { Card, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';

/**
 * ADR-0083 — "HOW THIS ACTUALLY WORKS", for the person who has to trust it.
 *
 * The Control Tower shows an operator a queue and some percentages. What it never showed was the thing
 * they most need in order to act on it: what runs, in what order, which parts involve a language model,
 * and what is switched on RIGHT NOW for this tenant.
 *
 * THE PAGE HAS ONE RULE AND IT IS THE WHOLE DESIGN: every status on it is READ FROM THE SYSTEM, never
 * declared. A page that says "the narrator is active" because a constant says so is worse than no page —
 * it manufactures confidence and is wrong exactly when it matters. The provider check is a real config
 * read; the sweep check is the newest verdict's timestamp; the assistant check is the caller's own grant.
 *
 * AND IT SAYS WHAT DOES *NOT* RUN. Autonomy is rendered as a row with the reason it is off, rather than
 * omitted. An admin looking at an "AI Control Tower" is entitled to know that nothing here acts on its
 * own, and to see that as a decision (ADR-0083 §2.5, autonomy per action type, none granted) rather than
 * discovering it by accident.
 */
export default async function HowItWorksPage() {
  const s = await requireAdmin();
  const t = await getTranslations('controlTower');
  const [agents, domains] = [await agentStatuses(s), domainsFor(s)];

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('howTitle')}
        description={t('howDescription')}
        back={{ href: '/control-tower', label: t('backToTower') }}
      />

      {/* ── The loop, drawn. Inline SVG: no asset, no request, and it themes with the page. ────────── */}
      <Card className="p-5">
        <SectionHeader title={t('loopTitle')} />
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('loopIntro')}</p>
        <div className="overflow-x-auto">
          <svg viewBox="0 0 940 150" className="h-auto w-full min-w-[720px]" role="img" aria-label={t('loopAlt')}>
            <defs>
              <marker id="ct-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
              </marker>
            </defs>
            {[
              { x: 8, key: 'step1', kind: 'det' },
              { x: 196, key: 'step2', kind: 'det' },
              { x: 384, key: 'step3', kind: 'llm' },
              { x: 572, key: 'step4', kind: 'human' },
              { x: 760, key: 'step5', kind: 'det' },
            ].map((b, i) => (
              <g key={b.key}>
                <rect
                  x={b.x}
                  y={34}
                  width={172}
                  height={62}
                  rx={10}
                  className={
                    b.kind === 'llm'
                      ? 'fill-violet-500/10 stroke-violet-500/40'
                      : b.kind === 'human'
                        ? 'fill-amber-500/10 stroke-amber-500/40'
                        : 'fill-muted stroke-border'
                  }
                  strokeWidth={1}
                />
                <text x={b.x + 86} y={59} textAnchor="middle" className="fill-foreground text-[12px] font-semibold">
                  {t(`${b.key}Title`)}
                </text>
                <text x={b.x + 86} y={78} textAnchor="middle" className="fill-muted-foreground text-[10.5px]">
                  {t(`${b.key}Sub`)}
                </text>
                {i < 4 && (
                  <line
                    x1={b.x + 174}
                    y1={65}
                    x2={b.x + 194}
                    y2={65}
                    className="stroke-muted-foreground"
                    strokeWidth={1.5}
                    markerEnd="url(#ct-arrow)"
                  />
                )}
              </g>
            ))}
            {/* The feedback edge. It is drawn because a loop that does not return is a pipeline, and the
                whole claim of a control tower is that the last step changes the first. */}
            <path
              d="M 846 100 L 846 128 L 94 128 L 94 100"
              fill="none"
              className="stroke-muted-foreground/60"
              strokeWidth={1.2}
              strokeDasharray="4 4"
              markerEnd="url(#ct-arrow)"
            />
            <text x={470} y={143} textAnchor="middle" className="fill-muted-foreground text-[10.5px]">
              {t('loopBack')}
            </text>
          </svg>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-muted align-middle ring-1 ring-border" />{t('legendDeterministic')}</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-violet-500/30 align-middle ring-1 ring-violet-500/40" />{t('legendLlm')}</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500/30 align-middle ring-1 ring-amber-500/40" />{t('legendHuman')}</span>
        </div>
      </Card>

      {/* ── What is switched on. Read from the system, every one. ─────────────────────────────────── */}
      <Card className="p-5">
        <SectionHeader title={t('agentsTitle')} />
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('agentsIntro')}</p>
        <ul className="space-y-3">
          {agents.map((a) => (
            <li key={a.id} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t(`agent.${a.id}`)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                    a.kind === 'llm'
                      ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {t(`kind.${a.kind}`)}
                </span>
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                    a.active
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : a.offByDesign
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  }`}
                >
                  {a.active ? t('statusOn') : a.offByDesign ? t('statusByDesign') : t('statusOff')}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t(`agent.${a.id}Does`)}</p>
              {/* The REASON, always. "Off" with no explanation is the thing an operator cannot act on. */}
              <p className="mt-1 text-xs">{t(`why.${a.reasonKey}`)}</p>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── The domains. One live, three named — see the comment on CONTROL_DOMAINS. ──────────────── */}
      <Card className="p-5">
        <SectionHeader title={t('domainsTitle')} />
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('domainsIntro')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {domains.map((d) => (
            <div key={d.id} className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t(`domain.${d.labelKey}`)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                    d.status === 'live'
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {t(`domainStatus.${d.status}`)}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t(`domain.${d.labelKey}Does`)}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t(`trigger.${d.trigger}`)}
                {d.detectorCount > 0 && ` · ${t('checksCount', { n: d.detectorCount })}`}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {/* ── The two promises. Both are enforced in code, not asserted here. ───────────────────────── */}
      <Card className="p-5">
        <SectionHeader title={t('promisesTitle')} />
        <ul className="space-y-3 text-sm">
          <li>
            <p className="font-medium">{t('promise1')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('promise1Body')}</p>
          </li>
          <li>
            <p className="font-medium">{t('promise2')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('promise2Body')}</p>
          </li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          <Link href="/control-tower" className="font-medium text-primary hover:underline">
            {t('backToTower')}
          </Link>
        </p>
      </Card>
    </div>
  );
}
