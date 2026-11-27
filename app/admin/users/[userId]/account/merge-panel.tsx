/** Board 0735d1b7 — the merge section of an account page (group administrators only). A login merged away shows which
 * master it belongs to, who merged it and when, and offers Undo merge, with the access it carried to the master listed
 * for HR to keep or remove (unticked: kept). A master lists the logins merged into it. Nothing otherwise. */
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {isGroupAdmin} from '@/lib/authz';
import {readLoginMergeState} from '@/core/login-merge';
import {ActionNavigateForm} from '@/components/action-navigate-form';
import {Card,Field,inputCls} from '@/components/ui';
import {formatDmyTime} from '@/lib/date-display';
import {ManualSubmit} from '../../manual-submit';
import {undoLoginMergeAction} from '../../duplicates/actions';

export async function LoginMergePanel({userId}:{userId:string}){
 const s=await getSession();
 if(!isGroupAdmin(s))return null;
 const state=await readLoginMergeState(s,userId).catch(()=>null);
 if(!state||(!state.mergedInto&&!state.mergedLogins.length))return null;
 const t=await getTranslations('accountManagement.merge'),users=await getTranslations('admin.users');
 const merged=state.mergedInto;
 return <section className="space-y-3" aria-labelledby="login-merge-title"><h2 id="login-merge-title" className="font-medium">{t('title')}</h2>
  {merged&&<Card className="space-y-4 border-amber-500/40 p-5">
   <p className="text-sm">{t.rich('mergedInto',{name:merged.masterName??t('unnamed'),link:chunks=><Link href={`/admin/users/${merged.masterId}/account`} className="font-medium text-primary underline">{chunks}</Link>})}</p>
   <p className="text-sm text-muted-foreground">{t('mergedBy',{name:merged.mergedByName??t('unnamed'),at:formatDmyTime(merged.mergedAt)})}</p>
   <p className="text-sm">{t('reasonShown',{reason:merged.reason})}</p>
   <p className="text-sm text-muted-foreground">{t('undoHelp')}</p>
   <ActionNavigateForm action={undoLoginMergeAction} className="space-y-3">
    <input type="hidden" name="mergeId" value={merged.id}/><input type="hidden" name="userId" value={userId}/>
    {(merged.carried.roles.length>0||merged.carried.assistant)&&<fieldset className="space-y-2"><legend className="text-sm font-medium">{t('carriedTitle')}</legend>
     {merged.carried.roles.map(grant=><label key={grant.roleAssignmentId} className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" name="removeRole" value={grant.roleAssignmentId} className="mt-1 size-5"/>
      <span>{t('removeRole',{role:users(`role.${grant.role}`),scope:grant.companyName??users('groupWide')})}</span></label>)}
     {merged.carried.assistant&&<label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" name="removeAssistant" className="mt-1 size-5"/><span>{t('removeAssistant')}</span></label>}
    </fieldset>}
    <Field label={t('undoReason')}><textarea name="reason" required minLength={5} maxLength={500} className={`${inputCls} min-h-20`}/></Field>
    <ManualSubmit variant="outline">{t('undo')}</ManualSubmit>
   </ActionNavigateForm>
  </Card>}
  {state.mergedLogins.length>0&&<Card className="space-y-2 p-5"><p className="text-sm text-muted-foreground">{t('masterHelp')}</p>
   <ul className="divide-y divide-border">{state.mergedLogins.map(login=><li key={login.mergeId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
    <Link href={`/admin/users/${login.appUserId}/account`} className="font-medium text-primary underline">{login.name??t('unnamed')}</Link>
    <span className="tabular-nums text-muted-foreground">{t('mergedOn',{at:formatDmyTime(login.mergedAt)})}</span></li>)}</ul></Card>}
 </section>;
}
