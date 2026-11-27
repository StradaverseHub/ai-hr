'use client';
/** Board 0735d1b7: Unlock Password Account on the account's own page, bound to that one account (it used to be a
 * person picker at the top of the Users list). Shown only while the password is locked; the owner,
 * core/password-policy.ts unlockPasswordAccount, re-checks group administration and the exact internal identity. */
import { ActionButton } from '@/components/ui/action-button';
import {useActionState} from 'react';
import {useTranslations} from 'next-intl';
import {unlockPasswordAccountAction} from './password-unlock-actions';
import {btnGhost} from '@/components/ui';
import {formatDmyTime} from '@/lib/date-display';
export function PasswordUnlock({userId,lockedAt}:{userId:string;lockedAt:number}){
 const t=useTranslations('passwordPolicy'),a=useTranslations('accountManagement'),[state,action,pending]=useActionState(unlockPasswordAccountAction,{status:'idle'});
 return <form action={action} className="space-y-3 rounded-lg border border-amber-500/40 bg-background p-5"><h3 className="font-medium">{t('full.unlockTitle')}</h3>
 <p className="text-sm text-muted-foreground">{a('lockedSince',{at:formatDmyTime(new Date(lockedAt))})}</p>
 <input type="hidden" name="userId" value={userId}/>
 <ActionButton aria-busy={pending} type="submit" className={`${btnGhost.replace('h-9','min-h-11')} whitespace-normal`} disabled={pending||state.status==='saved'}>{t('full.unlockAction')}</ActionButton>
 {state.status!=='idle'&&<p className="text-sm" role={state.status==='saved'?'status':'alert'}>{t(state.status==='saved'?'full.unlocked':'result.forbidden')}</p>}
 </form>;
}
