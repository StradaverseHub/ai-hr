'use client';
import { useActionState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { INITIAL_TESTING_ACTION_STATE, type TestingActionState } from '@/lib/system-testing/action-model';
import { btnPrimary } from '@/components/ui';
/** Only explicitly exported use-server actions enter this form; no arbitrary owner function crosses RSC. */
export function TestingActionForm({ action,children,label,className='' }: { action: (state: TestingActionState,form: FormData)=>Promise<TestingActionState>; children: ReactNode; label: string; className?: string }) {
  const [state,submit,pending]=useActionState(action,INITIAL_TESTING_ACTION_STATE);
  const t=useTranslations('systemTestingWorkspace');
  return <form action={submit} className={className}>
    {children}
    {state.error&&<p role="alert" className="my-3 break-words text-sm text-destructive">{t(`errors.${state.error}`)}</p>}
    <button type="submit" className={btnPrimary} disabled={pending}>{pending?t('saving'):label}</button>
  </form>;
}
