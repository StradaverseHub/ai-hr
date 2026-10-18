'use client';
import { onboardingTimestamp } from '@/lib/onboarding-format';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, inputCls, PageHeader } from '@/components/ui';
import { changeOnboarding } from '../onboarding/v31-actions';
export function DeviceAcknowledgement({ view, showHeading = true }: {
    showHeading?: boolean;
    view: {
        id: string;
        revision: number;
        name: string;
        available: boolean;
        submittedAt: string | null;
    } | null;
}) {
    const copy = useOnboardingCopy();
    const [contact, setContact] = useState(''), [serial, setSerial] = useState(''), [accessories, setAccessories] = useState(''), [confirmed, setConfirmed] = useState(false), [error, setError] = useState(''), [busy, start] = useTransition(), router = useRouter();
    return <div className="mx-auto max-w-2xl space-y-5">{showHeading && <PageHeader title={copy("Device acceptance acknowledgement")}/>}{!view ? <p>{copy("No onboarding acknowledgement is linked to your account.")}</p> : <Card className="space-y-4 p-5"><h2 className="font-medium">{view.name}</h2>{view.submittedAt ? <p role="status">{copy("Your acknowledgement was recorded on ")}{onboardingTimestamp(view.submittedAt)}.</p> : !view.available ? <p>{copy("Your acknowledgement opens after Group Tech records the Day 1 handover.")}</p> : <form className="space-y-4" onSubmit={e => {
                    e.preventDefault();
                    start(async () => {
                        const r = await changeOnboarding(view.id, view.revision, { type: 'acknowledge', data: { contactNumber: contact, serialNumber: serial, accessories, acknowledged: 'true' } });
                        if (r.error)
                            setError(r.error);
                        else
                            router.refresh();
                    });
                }}>{error && <p role="alert" className="text-destructive">{error}</p>}<Field label={copy("Contact number")} required><input required className={inputCls} value={contact} onChange={e => setContact(e.target.value)}/></Field><Field label={copy("Device serial number")} required><input required className={inputCls} value={serial} onChange={e => setSerial(e.target.value)}/></Field><Field label={copy("Accessories received")}><input className={inputCls} value={accessories} onChange={e => setAccessories(e.target.value)}/></Field><label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{copy("I confirm that I received the listed equipment and accessories.")}</label><Button type="submit" disabled={busy || !confirmed}>{copy("Submit acknowledgement")}</Button></form>}</Card>}</div>;
}
