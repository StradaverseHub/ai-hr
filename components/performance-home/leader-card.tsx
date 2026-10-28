import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/card';
import { Status, type StatusTone } from '@/components/monolith';
import { MONO_LABEL } from '@/components/monolith/classes';
import { cn } from '@/lib/utils';
import type { RunningLeaderStatus } from '@/packs/performance/onehr/performance-home-model';

/**
 * D-P1-32 PT-X3: the leader card of the Performance home, by the viewer's highest live seat as getLeaderStatus
 * (0666) decides it: a BU CEO "Where your BU is", a BG CEO "Where the group is", a Group Chief "Where your group
 * is". An HOD gets no card (the read returns none while the cycle runs). RENDERING ONLY: counts, states and lock
 * dates; the projection carries no person's band, so none can be drawn.
 *
 * Long lists (departments, business units, batches) scroll inside the card, so the page keeps one screen.
 */
const TONE: Record<'locked' | 'ready' | 'waiting' | 'calibrating', StatusTone> = { locked: 'ink', ready: 'signal', waiting: 'mid', calibrating: 'mid' };
const SCROLL = 'max-h-72 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export async function LeaderCard({ status, unit }: { status: RunningLeaderStatus; unit?: string }) {
  const t = await getTranslations('performanceArea');
  const format = await getFormatter();
  const day = (iso: string | null) => (iso ? format.dateTime(new Date(`${iso}T00:00:00Z`), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

  if (status.seat === 'bu') {
    const selected = status.units.find((u) => u.companyId === unit) ?? status.units[0] ?? null;
    const unitWord = (state: 'locked' | 'part' | 'open') => t(state === 'locked' ? 'home.rail.states.locked' : state === 'part' ? 'home.rail.states.progress' : 'home.rail.states.open');
    return (
      <Card data-home-card="leader" data-seat="bu" className="min-w-0 space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">{t('home.bu.title')}</h2>
          {selected && (
            <p className="text-sm text-muted-foreground">
              {[status.midYear ? t('homeHelp.leader.midYear') : null, t('homeHelp.leader.buMeta', { people: selected.people, departments: selected.departments })].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        {status.units.length > 1 && (
          <nav aria-label={t('homeHelp.leader.units')} className="flex flex-wrap gap-2">
            {status.units.map((u) => (
              <Link key={u.companyId} href={`/performance/home?${new URLSearchParams({ unit: u.companyId })}`} data-unit={u.companyId}
                aria-current={u.companyId === selected?.companyId ? 'true' : undefined}
                className={cn('inline-flex min-h-9 items-center gap-1 rounded-md border px-3 text-sm pointer-coarse:min-h-11',
                  u.companyId === selected?.companyId ? 'border-primary font-semibold text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                <b className="font-medium">{u.label}</b><span>· {unitWord(u.state)}</span>
              </Link>
            ))}
          </nav>
        )}
        {selected && (
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {selected.axes.map((a) => {
              const label = t(a.axis === 'performance' ? 'home.bu.columns.performance' : a.axis === 'potential' ? 'home.bu.columns.potential' : 'home.bu.midYearDepartmentReviews');
              const word = a.axis === 'departmentReviews'
                ? (a.of === 0 ? t('home.bu.midYearNoHodReview') : t('homeHelp.leader.inOf', { in: a.in, of: a.of }))
                : a.state === 'locked' ? t('home.axis.locked', { date: day(a.lockedOn) }) : a.state === 'ready' ? t('home.axis.ready') : t('home.axis.notReady');
              return (
                <div key={a.axis} data-axis={a.axis} data-state={a.state} className="min-w-0 space-y-1 rounded-md border border-border p-3 monolith:border-hairline">
                  <p className={cn('text-xs text-muted-foreground', MONO_LABEL)}>{label}</p>
                  <Status word={word} tone={TONE[a.state]} className="w-fit normal-case" />
                  {a.of > 0 && <p className="text-sm text-muted-foreground">{t('homeHelp.leader.reviewsLine', { in: a.in, of: a.of })}</p>}
                </div>
              );
            })}
          </div>
        )}
        {selected && selected.depts.length > 0 && (
          <div role="table" aria-label={t('home.bu.midYearDepartmentReviews')} data-home-depts className="min-w-0 text-sm">
            <div role="row" className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border pb-2 text-xs text-muted-foreground monolith:border-hairline">
              <span role="columnheader">{t('home.bu.columns.department')}</span>
              <span role="columnheader">{t('home.bu.columns.performance')}</span>
              <span role="columnheader">{t('home.bu.columns.potential')}</span>
            </div>
            <div role="rowgroup" tabIndex={0} aria-label={t('homeHelp.leader.scrolls', { label: t('home.bu.midYearDepartmentReviews') })} data-scroll-inside className={SCROLL}>
              {selected.depts.map((d, i) => (
                <div role="row" key={`${d.name ?? ''}.${i}`} className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border py-2 last:border-b-0 monolith:border-hairline">
                  <span role="cell" className="truncate" title={d.name ?? undefined}>{d.name ?? '—'}</span>
                  <span role="cell" className={d.performanceInOn ? '' : 'text-muted-foreground'}>{d.performanceInOn ? t('home.bu.in', { date: day(d.performanceInOn) }) : t('home.bu.toSubmit')}</span>
                  <span role="cell" className={d.potentialInOn ? '' : 'text-muted-foreground'}>{d.potentialInOn ? t('home.bu.in', { date: day(d.potentialInOn) }) : t('home.bu.toSubmit')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    );
  }

  const group = status.seat === 'group';
  // One row shape for both seats (a BG row also carries its companyId, which the card does not draw).
  const rows: readonly { label: string | null; people: number; state: 'locked' | 'ready' | 'calibrating'; lockedOn: string | null; in: number; of: number }[] = status.rows;
  const unitLabel = t(group ? 'home.bg.columns.batch' : 'home.bg.columns.businessUnit');
  const what = t(status.midYear ? 'home.bg.columns.departmentReviews' : group ? 'home.bg.columns.ratings' : 'home.bg.columns.buCalibration');
  const meta = status.midYear
    ? `${t('homeHelp.leader.midYear')} · ${t('homeHelp.leader.bgMetaMidYear', { ready: status.ready, total: status.total })}`
    : t('homeHelp.leader.bgMeta', { ready: status.ready, total: status.total, locked: status.locked });
  return (
    <Card data-home-card="leader" data-seat={status.seat} className="min-w-0 space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">{t(group ? 'home.group.title' : 'home.bg.title')}</h2>
        <p className="text-sm text-muted-foreground">{meta}</p>
      </div>
      <div role="table" aria-label={unitLabel} className="min-w-0 text-sm">
        <div role="row" className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2 border-b border-border pb-2 text-xs text-muted-foreground monolith:border-hairline">
          <span role="columnheader">{unitLabel} · {what}</span>
          <span role="columnheader">{t(status.midYear ? 'home.bg.columns.reviewsIn' : 'home.bg.columns.talentBox')}</span>
        </div>
        <div role="rowgroup" tabIndex={0} aria-label={t('homeHelp.leader.scrolls', { label: unitLabel })} data-scroll-inside className={SCROLL}>
          {rows.map((r, i) => {
            const noHod = status.midYear && r.of === 0;
            const word = r.state === 'locked' ? t('home.axis.locked', { date: day(r.lockedOn) })
              : noHod ? t('home.bu.midYearNoHodReview')
              : status.midYear ? t('homeHelp.leader.inOf', { in: r.in, of: r.of })
              : r.state === 'ready' ? t('home.axis.ready') : t('home.bg.calibrating');
            const sub = [t('homeHelp.people', { count: r.people }), !status.midYear && r.state === 'calibrating' && r.of > 0 ? t('homeHelp.leader.inOf', { in: r.in, of: r.of }) : null].filter(Boolean).join(' · ');
            return (
              <div role="row" key={`${r.label ?? ''}.${i}`} data-row-state={r.state} className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-center gap-2 border-b border-border py-2 last:border-b-0 monolith:border-hairline">
                <span role="cell" className="min-w-0"><b className="block truncate font-medium" title={r.label ?? undefined}>{r.label ?? '—'}</b><span className="block truncate text-muted-foreground">{sub}</span></span>
                <span role="cell"><Status word={word} tone={TONE[r.state]} className="w-fit normal-case" /></span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
