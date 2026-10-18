'use client';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { useState, useTransition } from 'react';
import { Button, Card } from '@/components/ui';
import { setupOnboarding } from './v31-actions';
export function OnboardingSetup({ master, initialized }: {
    master: boolean;
    initialized: boolean;
}) {
    const copy = useOnboardingCopy();
    const [error, setError] = useState(''), [pending, start] = useTransition();
    return <Card className="mx-auto max-w-xl space-y-4 p-6"><h1 className="text-xl font-semibold">{copy("Onboarding")}</h1><p>{initialized ? copy("Ask the Master Admin for Onboarding access. Assigned work remains available in My tasks.") : copy("Set up checklists, equipment and assignment groups before new hires enter onboarding. Existing cases and history are preserved.")}</p>{error && <p role="alert" className="text-destructive">{error}</p>}{master && !initialized && <Button disabled={pending} onClick={() => start(async () => {
                const r = await setupOnboarding();
                if (r.error)
                    setError(r.error);
                else
                    window.location.reload();
            })}>{pending ? copy("Setting up…") : copy("Set up onboarding")}</Button>}<a href="/tasks" className="block text-primary underline">{copy("Open My tasks")}</a></Card>;
}
