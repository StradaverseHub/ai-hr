import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, ErrorBanner, PageHeader, SectionHeader, Button } from '@/components/ui';
import { LEVEL, getMyOnboarding, lifecycleWorklist, listAssetRequests, listCases, listRequisitions, pendingApprovals, whenOf } from '@/packs/lifecycle/service';
import { requireModule } from '@/lib/authz';
import { lifecycleSession } from './_guard';
import { LifecycleTabs, Pill, ProgressBar, fmt } from './_ui';

export default async function LifecycleHub({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // ADR-0077 slice 4: the module's entry page names its own courtesy guard (test/slice4-nav-gating.test.ts).
  await requireModule('lifecycle');
  const { s, level } = await lifecycleSession(0);
  const t = await getTranslations('lifecycle');
  const { error } = await searchParams;
  const mine = await getMyOnboarding(s);
  const myRequests = (await listAssetRequests(s, { mine: true })).slice(0, 5);
  const staff = level >= LEVEL.agent;
  const [onb, ofb, reqs, work, pending] = staff
    ? await Promise.all([listCases(s, 'onboarding'), listCases(s, 'offboarding'), listRequisitions(s, { status: 'open' }), lifecycleWorklist(s), pendingApprovals(s)])
    : [[], [], [], [], { requisitions: [], assetRequests: [] }];
  const tiles = [
    { href: '/lifecycle/onboarding', label: t('tabs.onboarding'), n: onb.length },
    { href: '/lifecycle/offboarding', label: t('tabs.offboarding'), n: ofb.length },
    { href: '/lifecycle/requisitions', label: t('hub.openRequisitions'), n: reqs.length },
    ...(level >= LEVEL.manager ? [{ href: '/lifecycle/requisitions?approval=pending', label: t('hub.awaitingApproval'), n: pending.requisitions.length + pending.assetRequests.length }] : []),
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} actions={<Link data-tour="lifecycle-request" href="/lifecycle/asset-requests/new"><Button size="sm">{t('hub.requestEquipment')}</Button></Link>} />
      <ErrorBanner message={error} />
      <LifecycleTabs level={level} active="overview" />

      {mine && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <div className="text-sm font-semibold">{t('hub.myOnboarding')}</div>
            <div className="text-xs text-muted-foreground">{mine.number} · {t('me.joinDate')} {fmt(mine.joinDate)}</div>
          </div>
          <ProgressBar percent={mine.progress.percent} label={t('hub.myOnboarding')} />
          <Link href="/lifecycle/me" className="text-sm text-primary underline-offset-2 hover:underline">{t('hub.openChecklist')}</Link>
        </Card>
      )}

      {staff && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {tiles.map((x) => (
              <Link key={x.href} href={x.href}><Card className="p-4 transition-colors hover:bg-accent"><div className="text-2xl font-semibold tabular-nums">{x.n}</div><div className="text-sm text-muted-foreground">{x.label}</div></Card></Link>
            ))}
          </div>
          <Card className="overflow-hidden">
            <SectionHeader title={t('worklist.title')} count={work.length} subtitle={t('worklist.hint')} />
            {work.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t('worklist.empty')}</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {work.map((w) => {
                  const when = whenOf(w.days);
                  return (
                    <li key={`${w.kind}-${w.ref}-${w.detail}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <div>
                        <Link href={w.href} className="font-medium text-primary underline-offset-2 hover:underline">{w.ref}</Link>{' '}
                        <span>{w.label}</span>
                        <div className="text-xs text-muted-foreground">
                          {w.kind === 'lastWorkingDay' && t('worklist.lastWorkingDay', { when: t(`worklist.when.${when.key}`, { n: when.n }), count: Number(w.detail) })}
                          {w.kind === 'onboardingStart' && t('worklist.onboardingStart', { when: t(`worklist.when.${when.key}`, { n: when.n }), requisition: w.detail.split('|')[0]!, done: w.detail.split('|')[1]!, total: w.detail.split('|')[2]! })}
                          {w.kind === 'approval' && t('worklist.approval', { kind: t(`worklist.kind.${w.detail}`), days: -w.days })}
                          {w.kind === 'expiry' && t('worklist.expiry', { field: t(`worklist.field.${w.detail}`), when: t(`worklist.when.${when.key}`, { n: when.n }) })}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}

      <Card data-tour="lifecycle-my-requests" className="overflow-hidden">
        <SectionHeader title={t('hub.myRequests')} count={myRequests.length} />
        {myRequests.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t('hub.noRequests')}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {myRequests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                <Link href={`/lifecycle/asset-requests/${r.number}`} className="text-primary underline-offset-2 hover:underline">{r.number}</Link>
                <span className="flex-1 truncate">{r.itemName}</span>
                <Pill value={r.status} label={t(`status.${r.status}`)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
