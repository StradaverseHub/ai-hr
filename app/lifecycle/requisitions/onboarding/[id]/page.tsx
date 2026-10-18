import { onboardingTimestamp } from '@/lib/onboarding-format';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/authz';
import { onboardingDetail, onboardingRequisitionStatus } from '@/packs/lifecycle/service';
import { OnboardingError } from '@/lib/onboarding-model';
import { OnboardingCaseView } from '../../../onboarding/case-view';
import { Card, PageHeader } from '@/components/ui';
export default async function Page({ params, searchParams }: {
    params: Promise<{
        id: string;
    }>;
    searchParams: Promise<{
        generation?: string;
    }>;
}) {
    const s = await requireModule('lifecycle'), { id } = await params, { generation } = await searchParams;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        notFound();
    const detail = await onboardingDetail(s, id, 'requisition', generation).catch(e => {
        if (e instanceof OnboardingError && ['not_found', 'forbidden'].includes(e.code))
            notFound();
        throw e;
    });
    if (!generation)
        return <OnboardingCaseView key={detail.revision} detail={detail} mode="requisition"/>;
    const r = detail.case.requisitions.find(r => r.id === generation);
    if (!r)
        notFound();
    const name = (id: string | null) => detail.directory.find(u => u.id === id)?.name ?? id ?? 'Unassigned';
    return <div className="space-y-5"><PageHeader title={r.number} description={onboardingRequisitionStatus(r).replaceAll('_', ' ')}/><p className="text-sm text-muted-foreground">Historical requisition for {detail.case.source.fullName ?? detail.case.local.fullName}. Its original items, approvals and decisions are retained.</p><Link className="text-primary underline" href={'/lifecycle/requisitions/onboarding/' + id}>View current requisition</Link>{r.items.map(i => <Card key={i.id} className="space-y-2 p-4"><h2 className="font-medium">{i.name}</h2><p className="text-sm">{i.source} · {i.approval} · {i.state}{i.removed ? ' · Removed' : ''}</p><p className="text-sm">{i.reason}</p>{i.steps.map(step => <p key={step.id} className="text-sm">{step.label}: {step.status}{step.by ? ' · ' + (step.byName ?? name(step.by)) : ''}{step.when ? ' · ' + onboardingTimestamp(step.when) : ''}</p>)}</Card>)}<section className="space-y-2"><h2 className="font-medium">Activity log</h2>{detail.case.history.filter(h => h.at >= r.createdAt && (!r.cancelledAt || h.at <= r.cancelledAt)).map(h => <p key={h.id} className="text-sm">{h.action.replaceAll('.', ' ')} · {h.detail} · {h.name} · {onboardingTimestamp(h.at)}</p>)}</section></div>;
}
