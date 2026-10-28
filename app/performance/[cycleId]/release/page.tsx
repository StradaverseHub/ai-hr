import Link from 'next/link';
import { z } from 'zod';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { isOnehrOnlyPerformanceAdmin, requireOnehrAdminAccess } from '@/lib/authz';
import { getOnehrReleaseBoard, isOnehrAdminCycle } from '@/packs/performance/service';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ReleaseBoard } from '../../onehr/release-board';
import { PerformanceAdminShell } from '../../onehr/admin-shell';

type Query = { businessGroup?: string; companyId?: string; department?: string; status?: string; outcome?: string; error?: string };
const counts = z.partialRecord(z.enum(['performance', 'potential', 'talent', 'feedback']), z.number().int().min(0)).default({});
const outcomeSchema = z.object({
  step: z.enum(['leaders', 'employees', 'both']), action: z.enum(['release', 'revoke']),
  done: counts, noResult: counts, leadersFirst: counts, stillWithEmployee: counts, notAllowed: z.number().int().min(0),
  notified: z.object({ leaders: z.number().int().min(0), people: z.number().int().min(0) }),
});
/** The redirect's summary of the last bulk action (bulkReleaseAction); anything malformed shows nothing. */
function parseOutcome(raw: string | undefined) {
  if (!raw || raw.length > 4000) return null;
  try { const parsed = outcomeSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))); return parsed.success ? parsed.data : null; } catch { return null; }
}

/** WP-E (CF-08) — release results in two steps for a cycle, with the business group / unit / department / Show filters. */
export default async function ReleaseResultsPage({ params, searchParams }: { params: Promise<{ cycleId: string }>; searchParams: Promise<Query> }) {
  const s = await requireOnehrAdminAccess(), { cycleId } = await params, q = await searchParams, t = await getTranslations('onehr.resultRelease');
  // ADR-0142 — the performance partner reaches OneHR-native cycles only.
  if (isOnehrOnlyPerformanceAdmin(s) && !await isOnehrAdminCycle(s, cycleId)) notFound();
  const v = await getOnehrReleaseBoard(s, cycleId, { businessGroup: q.businessGroup, companyId: q.companyId, department: q.department, status: q.status as never });
  const outcome = parseOutcome(q.outcome), mid = v.cycle.kind === 'mid_year';
  const base = `/performance/${cycleId}/release`;
  const show = (status: string) => { const p = new URLSearchParams(Object.entries({ ...v.filters, status }).filter((e) => !!e[1])); return `${base}${p.size ? `?${p}` : ''}`; };
  const list = (m: Partial<Record<string, number>>) => Object.entries(m).filter(([, n]) => n).map(([c, n]) => t('outcome.item', { component: t(`outcome.component.${c}`), count: n! })).join('; ');
  const verb = outcome ? `${outcome.action}${outcome.step === 'leaders' ? 'Leaders' : outcome.step === 'employees' ? 'Employees' : 'Both'}` : '';
  const chips = [['', 'showAll', v.counts.all], ['ready', 'showReady', v.counts.ready], ['with_leaders', 'showWithLeaders', v.counts.withLeaders], ['to_emp', 'showToEmp', v.counts.toEmp], ['notfinal', 'showNotFinal', v.counts.notFinal]] as const;
  // D-P1-32 PT-X4: the page keeps its address and is drawn inside the admin area as Cycle › Release results.
  return <PerformanceAdminShell cycleId={cycleId} cycleName={v.cycle.name} section="cycle" tab="release"><div className="mx-auto max-w-[1600px] space-y-6">
    <PageHeader back={{ href: `/performance/${cycleId}`, label: t('back') }} title={t('title')} description={v.cycle.name}/>
    <ErrorBanner message={q.error}/>
    {outcome && <section role="status" aria-label={t('outcome.label')} className="space-y-1 rounded-md border border-border bg-muted/30 p-4 text-sm">
      <p>{list(outcome.done) ? t('outcome.done', { verb: t(`outcome.verb.${verb}`), list: list(outcome.done) }) : t('outcome.nothing')}</p>
      {list(outcome.noResult) && <p className="text-amber-700 dark:text-amber-400">{t('outcome.noResult', { list: list(outcome.noResult) })}</p>}
      {list(outcome.leadersFirst) && <p className="text-amber-700 dark:text-amber-400">{t('outcome.leadersFirst', { list: list(outcome.leadersFirst) })}</p>}
      {list(outcome.stillWithEmployee) && <p className="text-amber-700 dark:text-amber-400">{t('outcome.still', { list: list(outcome.stillWithEmployee) })}</p>}
      {outcome.notAllowed > 0 && <p className="text-amber-700 dark:text-amber-400">{t('outcome.notAllowed', { count: outcome.notAllowed })}</p>}
      {outcome.action === 'release' && <p className="text-muted-foreground">{t('outcome.notified', outcome.notified)}</p>}
    </section>}
    <p className="max-w-3xl text-sm text-muted-foreground">{t('lede')}</p>
    {!v.cycle.potential && <p className="text-sm font-medium">{t('noPotential')}</p>}
    <section aria-label={t('stepsLabel')} className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
      <Card className="flex gap-4 p-5"><span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">1</span>
        <div className="space-y-1"><h2 className="font-semibold">{t('step1')}</h2>
          <p className="text-sm">{t('counts', { released: v.counts.leadAll, ready: v.counts.ready })}{v.counts.notFinal > 0 && <span className="text-amber-700 dark:text-amber-400"> · {t(mid ? 'stillOpenMid' : 'stillOpen', { count: v.counts.notFinal })}</span>}</p>
          <p className="text-sm text-muted-foreground">{t('step1Help')}</p></div></Card>
      <span aria-hidden className="hidden self-center text-muted-foreground md:block">→</span>
      <Card className="flex gap-4 p-5"><span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">2</span>
        <div className="space-y-1"><h2 className="font-semibold">{t('step2')}</h2>
          <p className="text-sm">{t('counts', { released: v.counts.toEmp, ready: v.counts.withLeaders })}</p>
          <p className="text-sm text-muted-foreground">{t(mid ? 'step2HelpMid' : 'step2Help')}</p></div></Card>
    </section>
    <Card className="space-y-4 p-5" aria-label={t('filters')}>
      <form method="get" className="flex flex-wrap items-end gap-4">
        <Field label={t('businessGroup')}><select name="businessGroup" defaultValue={v.filters.businessGroup} className={inputCls}><option value="">{t('all')}</option>{v.options.businessGroups.map((g) => <option key={g} value={g}>{g}</option>)}</select></Field>
        <Field label={t('company')}><select name="companyId" defaultValue={v.filters.companyId} className={inputCls}><option value="">{t('all')}</option>{v.options.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label={t('department')}><select name="department" defaultValue={v.filters.department} className={inputCls}><option value="">{t('all')}</option>{v.options.departments.map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>
        {v.filters.status && <input type="hidden" name="status" value={v.filters.status}/>}
        <Button type="submit" variant="secondary">{t('apply')}</Button>
      </form>
      <nav aria-label={t('show')} className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted-foreground">{t('show')}</span>
        {chips.map(([status, key, n]) => <Link key={key} href={show(status)} aria-current={v.filters.status === status ? 'true' : undefined}
          className={`rounded-full border px-3 py-1 text-sm ${v.filters.status === status ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>{t(key)} <b>{n}</b></Link>)}
      </nav>
    </Card>
    {v.rows.length ? <ReleaseBoard cycleId={cycleId} cycleName={v.cycle.name} potential={v.cycle.potential} midYear={mid} email={v.email} filters={v.filters} rows={v.rows}/>
      : <Card className="p-5"><p className="text-sm text-muted-foreground">{v.filters.status ? t('emptyStatus') : t('empty')}</p></Card>}
  </div></PerformanceAdminShell>;
}
