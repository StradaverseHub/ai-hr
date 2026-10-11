import { randomUUID } from 'node:crypto';
import { getTranslations } from 'next-intl/server';
import { Card,SectionHeader,Field,inputCls } from '@/components/ui';
import type { ManualIdentityEnrollment } from '@/lib/identity/manual-model';
import { createManualAccountAction,resumeManualAccountAction,cancelManualAccountAction } from './manual-actions';
import { ManualSubmit } from './manual-submit';

export async function ManualAccountSetup({available,people,companies,roles,pending,selectedPerson}:{
 available:boolean;people:{id:string;name:string|null;code:string|null}[];
 companies:{id:string;name:string}[];roles:{value:string;label:string}[];pending:ManualIdentityEnrollment[];selectedPerson?:{id:string;name:string|null;email:string|null};
}) {
 const t=await getTranslations('admin.users.manual');
 return <Card id="manual-account-setup" data-testid="manual-account-setup"><SectionHeader title={t('title')}/><div className="space-y-5 p-4">
  <p className="text-sm text-muted-foreground">{available?t('description'):t('notEnabled')}</p>
  {available&&<>
   <form action={createManualAccountAction} className="grid gap-4 sm:grid-cols-2">
    <input type="hidden" name="id" value={randomUUID()}/>
    <Field label={t('person')}>{selectedPerson?<><input type="hidden" name="personId" value={selectedPerson.id}/><span className="py-2 text-sm">{selectedPerson.name}</span><a href="/admin/users#manual-account-setup" className="text-xs underline">{t('chooseAnotherEmployee')}</a></>:<select name="personId" required defaultValue="" className={inputCls}>
     <option value="" disabled>{t('choosePerson')}</option>{people.map(p=><option key={p.id} value={p.id}>{p.name}{p.code?` · ${p.code}`:''}</option>)}
    </select>}</Field>
    <Field label={t('email')}><input type="email" name="email" defaultValue={selectedPerson?.email??''} required maxLength={255} autoComplete="off" className={inputCls}/></Field>
    <Field label={t('username')}><input name="username" required minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._@+\-]{2,63}" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="manual-username-help" className={inputCls}/></Field>
    <Field label={t('password')}><input type="password" name="password" required minLength={14} maxLength={128} autoComplete="new-password" aria-describedby="manual-password-help" className={inputCls}/></Field>
    <p id="manual-username-help" className="text-xs text-muted-foreground">{t('usernameHelp')}</p>
    <p id="manual-password-help" className="text-xs text-muted-foreground">{t('passwordHelp')}</p>
    <Field label={t('role')}><select name="role" defaultValue="employee" className={inputCls}>{roles.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
    <Field label={t('scope')}><select name="companyId" defaultValue="" className={inputCls}><option value="">{t('groupWide')}</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="ownershipAttested" value="true" required className="mt-1"/>{t('attestation')}</label>
    <ManualSubmit className="w-fit">{t('create')}</ManualSubmit>
   </form>
   {pending.length>0&&<div className="space-y-4 border-t border-border pt-4"><h3 className="font-medium">{t('pendingTitle')}</h3><p className="text-sm text-muted-foreground">{t('pendingHelp')}</p>
    {pending.map(e=><div key={e.id} className="space-y-3 rounded-lg border border-border p-4">
     <p className="break-all text-sm font-medium">{e.username} · {e.email}</p>
     <p className="text-sm text-muted-foreground">{t(`state.${e.status as 'reserved'|'prepared'|'linked'}`)}</p>
     <form action={resumeManualAccountAction} className="flex flex-wrap items-end gap-3"><input type="hidden" name="id" value={e.id}/>
      {e.status!=='linked'&&<Field label={t('password')}><input type="password" name="password" required minLength={14} maxLength={128} autoComplete="new-password" className={inputCls}/></Field>}
      <ManualSubmit>{e.status==='linked'?t('finish'):t('retry')}</ManualSubmit>
     </form>
     {e.status!=='linked'&&<form action={cancelManualAccountAction}><input type="hidden" name="id" value={e.id}/><ManualSubmit variant="outline">{t('cancel')}</ManualSubmit></form>}
    </div>)}
   </div>}
  </>}
 </div></Card>;
}
