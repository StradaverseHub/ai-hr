'use client';
import { ActionButton } from '@/components/ui/action-button';
import {useActionState} from 'react';
import {useTranslations} from 'next-intl';
import {unlockPasswordAccountAction} from './password-unlock-actions';
import {btnGhost,inputCls} from '@/components/ui';
export function PasswordUnlock({users}:{users:{id:string;label:string}[]}){
 const t=useTranslations('passwordPolicy'),[state,action,pending]=useActionState(unlockPasswordAccountAction,{status:'idle'});
 return <form action={action} className="space-y-3 rounded-lg border border-border p-4"><h2 className="font-medium">{t('full.unlockTitle')}</h2>
 <label className="block text-sm">{t('full.unlockUser')}<select name="userId" className={inputCls} required defaultValue=""><option value="" disabled>{t('full.unlockChoose')}</option>{users.map(user=><option key={user.id} value={user.id}>{user.label}</option>)}</select></label>
 <ActionButton aria-busy={pending} type="submit" className={btnGhost} disabled={pending}>{t('full.unlockAction')}</ActionButton>
 {state.status!=='idle'&&<p className="text-sm" role={state.status==='saved'?'status':'alert'}>{t(state.status==='saved'?'full.unlocked':'result.forbidden')}</p>}
 </form>;
}
