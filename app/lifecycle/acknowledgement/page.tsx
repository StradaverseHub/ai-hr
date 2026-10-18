import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/authz';
import { onboardingMyAcknowledgements } from '@/packs/lifecycle/service';
import { DeviceAcknowledgement } from './form';
export default async function Page({ searchParams }: {
    searchParams: Promise<{
        case?: string;
    }>;
}) {
    const s = await requireModule('lifecycle'), sp = await searchParams, views = await onboardingMyAcknowledgements(s);
    const selected = sp.case ? views.filter(view => view.id === sp.case) : views;
    if (sp.case && !selected.length)
        notFound();
    return <div className="space-y-6">{!selected.length ? <DeviceAcknowledgement view={null}/> : selected.map((view, index) => <div key={view.id}><p className="mx-auto mb-2 max-w-2xl text-sm text-muted-foreground">{view.number} · {view.employeeId} · {view.joinDate.split('-').reverse().join('/')}</p><DeviceAcknowledgement view={view} showHeading={index === 0}/></div>)}</div>;
}
