'use client';
import {useRef,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {firstDirtyGuard} from '@/lib/unsaved-changes';

/** A General save may reshape the ladder. Keep this independent draft's fields and structural
 * identity together until the page is reopened; the service refuses stale identities explicitly.
 * The live action form, save receipt and refusal banner remain outside this retained field body. */
export function ScheduleOvertimeDraftFields({children,identity}:{children:ReactNode;identity:string}) {
  const initial=useRef({children,identity});
  const t=useTranslations('scheduleDrafts');
  const stale=initial.current.identity!==identity;
  const reload=()=>{
    const guard=firstDirtyGuard();
    if(guard)guard.prompt(()=>window.location.reload());
    else window.location.reload();
  };
  return <>{stale&&<div className="space-y-2 rounded border border-amber-300 p-3 text-sm">
    <p role="alert">{t('staleLadder')}</p>
    <button type="button" className="underline underline-offset-2" onClick={reload}>{t('reload')}</button>
  </div>}{initial.current.children}</>;
}
