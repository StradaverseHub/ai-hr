import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { getAssessmentAssessorProgress, getAssessmentProgress } from '@/packs/performance/service';
import { Card } from '@/components/ui';
import type { Policy } from '@/packs/performance/onehr/model';
import { overviewModuleOn, overviewProgressModule, overviewWindows, type OverviewModule } from '@/packs/performance/onehr/overview-model';
import { progressStages } from '@/packs/performance/onehr/progress-model';
import { adminPageHref } from '@/packs/performance/onehr/admin-sections';

/** How many late people the Overview names before it points to the module's Run page for the rest. */
export const LATE_SHOWN = 25;

type Late = { key: string; name: string; href: string | null; company: string; department: string; detail: string };

/**
 * D-P1-32 PT-X4 — ONE module Overview, keyed by module (OneHR's `admin_module_dashboard`): how many people stand
 * at each of the module's stages and, once the module's window has closed, who is not done. Existing readers only,
 * no new SQL: Review progress (completion metadata for the people taking part) and, for 360 Feedback, the raters'
 * progress, because the people late there are the raters. No answer, rating or remark crosses either reader.
 */
export async function ModuleOverview({ cycleId, section, module, policy, cycleName }: {
  cycleId: string;
  section: string;
  module: OverviewModule;
  policy: Pick<Policy, 'kind' | 'modules' | 'windows'>;
  cycleName: string;
}) {
  const { s } = await scopedSession();
  const progressModule = overviewProgressModule[module];
  const [t, tp, locale, progress, raters] = await Promise.all([
    getTranslations('performanceAdmin.overview'),
    getTranslations('onehr.progressAdmin'),
    getLocale(),
    getAssessmentProgress(s, cycleId, { module: progressModule }),
    module === 'f360' ? getAssessmentAssessorProgress(s, cycleId) : Promise.resolve(null),
  ]);
  // The reader falls back to another module when this one has nobody; never count that module's rows here.
  const on = overviewModuleOn(policy, module) && progress.availableModules.includes(progressModule);
  const rows: typeof progress.rows = on ? progress.rows : [];
  const stages = progressStages(progressModule, policy.kind);
  const counts = new Map(stages.map((k) => [k, 0]));
  for (const r of rows) { const label = r.cells[progressModule]?.label; if (label) counts.set(label, (counts.get(label) ?? 0) + 1); }
  const w = policy.windows[overviewWindows[module]], now = Date.now();
  const date = (instant: string) => new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium' }).format(new Date(instant));
  const notOpen = !!w?.opensAt && now < Date.parse(w.opensAt), closed = !!w?.closesAt && now >= Date.parse(w.closesAt);
  const when = notOpen ? t('opens', { date: date(w!.opensAt!) }) : closed ? t('closed', { date: date(w!.closesAt!) }) : w?.closesAt ? t('closes', { date: date(w.closesAt) }) : t('noDates');
  const late: Late[] = !on || !closed ? [] : raters
    ? raters.filter((r) => r.state !== 'done').map((r) => ({ key: r.employmentId, name: r.name, href: null, company: r.company, department: r.department, detail: t('submitted', { done: r.done, assigned: r.assigned }) }))
    : rows.filter((r) => r.cells[progressModule] && r.cells[progressModule]!.state !== 'done').map((r) => ({ key: r.reviewId, name: r.name, href: `/performance/review/${r.reviewId}`, company: r.company, department: r.department, detail: tp(`labels.${r.cells[progressModule]!.label}`) }));
  late.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const run = adminPageHref(cycleId, section, 'run', module === 'f360' ? 'raterProgress' : undefined);
  return (
    <section aria-label={t('title')} className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">{t('stages')}</h2>
          <span className="text-sm text-muted-foreground">{t('people', { count: rows.length })} · {when}</span>
        </div>
        {on ? (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stages.map((k) => (
              <div key={k} className="rounded-md border border-border p-3">
                <dt className="text-xs text-muted-foreground">{tp(`labels.${k}`)}</dt>
                <dd className="text-lg font-semibold tabular-nums">{counts.get(k) ?? 0}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="text-sm text-muted-foreground">{t('off', { cycle: cycleName })}</p>}
      </Card>
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">{t('late')}</h2>
          {late.length > 0 && <span className="text-sm text-muted-foreground">{late.length}</span>}
        </div>
        {!on || !closed ? <p className="text-sm text-muted-foreground">{t('notYet')}</p>
          : !late.length ? <p className="text-sm text-muted-foreground">{t('noneLate')}</p>
          : (
            <ul className="divide-y divide-border">
              {late.slice(0, LATE_SHOWN).map((p) => (
                <li key={p.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
                  <span className="min-w-0">{p.href ? <Link href={p.href} className="text-primary hover:underline">{p.name}</Link> : p.name}<span className="block text-xs text-muted-foreground">{[p.company, p.department].filter(Boolean).join(' · ')}</span></span>
                  <span className="text-muted-foreground">{p.detail}</span>
                </li>
              ))}
            </ul>
          )}
        {late.length > LATE_SHOWN && <p className="text-sm"><Link href={run} className="text-primary hover:underline">{t('more', { count: late.length - LATE_SHOWN })}</Link></p>}
      </Card>
    </section>
  );
}
