import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {isGroupAdmin} from '@/lib/authz';
import {Button,Card,Field,inputCls} from '@/components/ui';
import {ConfirmSubmit} from '@/components/ui/confirm-submit';
import {leadershipPrinciples} from '@/packs/performance/onehr/framework-model';
import type {Policy} from '@/packs/performance/onehr/model';
import {onehrCycleAction} from '../onehr-actions';

export async function FrameworkAdmin({cycleId,revision,policy,closed,returnTo}:{cycleId:string;revision:number;policy:Policy;closed:boolean;returnTo?:string}){
 const [t,ctx]=await Promise.all([getTranslations('onehr.frameworkAdmin'),getSession()]),writable=!closed&&isGroupAdmin(ctx),principles=leadershipPrinciples(policy).filter(p=>!p.archived);
 const fields=(edit:string,principleId?:string,statementId?:string)=><><input type="hidden" name="cycleId" value={cycleId}/><input type="hidden" name="revision" value={revision}/>{returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}<input type="hidden" name="action" value="framework"/><input type="hidden" name="edit" value={edit}/>{principleId&&<input type="hidden" name="principleId" value={principleId}/>} {statementId&&<input type="hidden" name="statementId" value={statementId}/>}</>;
 return <Card className="space-y-3 p-5"><h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('help')}</p>{!writable&&<p className="text-sm text-muted-foreground">{closed?t('closed'):t('readonly')}</p>}
  <details><summary className="cursor-pointer font-medium">{t('edit')}</summary><div className="mt-4 space-y-4">
   {principles.map(principle=><details key={principle.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer font-medium">{principle.name}</summary><div className="mt-3 space-y-4">
    <form action={onehrCycleAction}>{fields('edit_principle',principle.id)}<fieldset disabled={!writable} className="space-y-3"><Field label={t('name')}><input required name="name" maxLength={200} defaultValue={principle.name} className={inputCls}/></Field><Field label={t('description')}><textarea name="description" maxLength={2000} defaultValue={principle.description} className={inputCls}/></Field>{writable&&<Button type="submit" variant="secondary">{t('save')}</Button>}</fieldset></form>
    {policy.framework.map((tier,index)=>{const statements=tier.statements.filter(s=>s.principleId?s.principleId===principle.id:s.principle===principle.name);return <fieldset key={index} className="space-y-3 border-t border-border pt-3"><legend className="text-sm font-medium">{t('tier',{n:index+1,min:tier.gradeMin,max:tier.gradeMax})}</legend>
     {!statements.length&&<p className="text-sm text-muted-foreground">{t('empty')}</p>}
     {statements.map(statement=><div key={statement.id} className="space-y-2 rounded-md border border-border p-3"><form action={onehrCycleAction}>{fields('edit_behaviour',undefined,statement.id)}<Field label={statement.future?t('future'):t('current')}><textarea required name="text" maxLength={2000} defaultValue={statement.text} disabled={!writable} className={inputCls}/></Field>{writable&&<Button type="submit" variant="secondary" size="sm" className="mt-2">{t('save')}</Button>}</form>{writable&&<form action={onehrCycleAction}>{fields('remove_behaviour',undefined,statement.id)}<ConfirmSubmit size="sm" variant="outline" description={t('removeHelp')}>{t('removeBehaviour')}</ConfirmSubmit></form>}</div>)}
     {writable&&<details><summary className="cursor-pointer text-sm font-medium">{t('addBehaviour')}</summary><form action={onehrCycleAction} className="mt-3 space-y-3">{fields('add_behaviour',principle.id)}<input type="hidden" name="tier" value={index}/><Field label={t('behaviour')}><textarea required name="text" maxLength={2000} className={inputCls}/></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="future"/>{t('future')}</label><Button type="submit" variant="secondary">{t('addBehaviour')}</Button></form></details>}
    </fieldset>;})}
    {writable&&<form action={onehrCycleAction}>{fields('remove_principle',principle.id)}<ConfirmSubmit variant="outline" description={t('removeHelp')}>{t('removePrinciple')}</ConfirmSubmit></form>}
   </div></details>)}
   {writable&&<details><summary className="cursor-pointer font-medium">{t('addPrinciple')}</summary><form action={onehrCycleAction} className="mt-3 space-y-3">{fields('add_principle')}<Field label={t('name')}><input required name="name" maxLength={200} className={inputCls}/></Field><Field label={t('description')}><textarea name="description" maxLength={2000} className={inputCls}/></Field><Button type="submit" variant="secondary">{t('addPrinciple')}</Button></form></details>}
  </div></details>
 </Card>;
}
