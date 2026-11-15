'use client';
import {useTranslations} from 'next-intl';
import {Plus,Trash2} from 'lucide-react';
import {PROBATION_APPROVAL_SIGNING_WHO,defaultProbationApprovals,probationApprovalChain,type ProbationApprovalRow,type ProbationForm} from '@/lib/probation-form';
const PARTS=['1','2','3'] as const;
/**
 * Review and approval routing on a form version (handoff B3, owner mockup screen 10). Core steps are shown greyed and
 * cannot change; approval rows run by order (lower first), rows sharing an order in the order listed. Every save makes
 * a new version, so a published version never changes and a case keeps the routing of the version it started on.
 */
export function ApprovalRoutingFields({value,change,disabled,users}:{value:ProbationForm;change:(value:ProbationForm)=>void;disabled:boolean;users:readonly {id:string;name:string}[]}){
 const t=useTranslations('probation');
 if(!value.approvals)return <section className="v9-panel v9-stack" aria-labelledby="probation-form-routing"><h3 id="probation-form-routing">{t('formRouting.title')}</h3><p className="v9-muted">{t('formRouting.legacy')}</p>
  <div><button type="button" className="v9-button" disabled={disabled} onClick={()=>change({...value,approvals:defaultProbationApprovals()})}>{t('formRouting.useForm')}</button></div></section>;
 const approvals=value.approvals;
 const setRows=(part:typeof PARTS[number],rows:ProbationApprovalRow[])=>change({...value,approvals:{...approvals,[part]:rows}});
 const policy=value.duplicateRolePolicy;
 return <section className="v9-panel v9-stack" aria-labelledby="probation-form-routing"><h3 id="probation-form-routing">{t('formRouting.title')}</h3><p className="v9-muted">{t('formRouting.help')}</p>
  {PARTS.map(part=>{const rows=approvals[part],unused=PROBATION_APPROVAL_SIGNING_WHO.filter(who=>!rows.some(row=>row.who===who));
   return <fieldset key={part} className="v9-stack" data-part={part}><legend>{t('partTitle',{part})}</legend>
    <p className="v9-muted" data-core-steps>{t('formRouting.core',{steps:t(part==='1'?'formRouting.coreKpi':'formRouting.coreReview')})}</p>
    {probationApprovalChain(rows).map(row=>{const index=rows.indexOf(row),update=(patch:Partial<ProbationApprovalRow>)=>setRows(part,rows.map((item,i)=>i===index?{...item,...patch}:item));
     return <div className="v9-fields" key={row.id} data-approval-row={row.id}>
      <label className="v9-field"><span>{t('formRouting.order')}</span><input type="number" min={1} max={9} step={1} value={row.order} disabled={disabled} onChange={e=>update({order:Math.max(1,Math.min(9,Math.floor(Number(e.target.value)||1)))})}/></label>
      <label className="v9-field"><span>{t('formRouting.action')}</span><select value={row.action} disabled={disabled} onChange={e=>update({action:e.target.value as ProbationApprovalRow['action']})}><option value="approve_sign">{t('formRouting.actions.approve_sign')}</option></select></label>
      <label className="v9-field"><span>{t('formRouting.who')}</span><select value={row.who} disabled={disabled} onChange={e=>update({who:e.target.value,id:e.target.value})}>{PROBATION_APPROVAL_SIGNING_WHO.filter(who=>who===row.who||!rows.some(other=>other.who===who)).map(who=><option key={who} value={who}>{t('roles.'+who)}</option>)}</select></label>
      <div className="v9-actions"><button type="button" className="v9-button" aria-label={t('formRouting.remove',{who:t('roles.'+row.who)})} disabled={disabled} onClick={()=>setRows(part,rows.filter((_,i)=>i!==index))}><Trash2 size={16}/></button></div>
     </div>;})}
    {!rows.length&&<p className="v9-muted">{t(part==='3'?'formRouting.partThreeRequired':'formRouting.none')}</p>}
    <div><button type="button" className="v9-button" disabled={disabled||!unused.length} onClick={()=>{const who=unused[0];setRows(part,[...rows,{id:who,order:Math.min(9,rows.reduce((max,row)=>Math.max(max,row.order),0)+1),action:'approve_sign',who}]);}}><Plus size={16}/>{t('formRouting.add')}</button></div>
   </fieldset>;})}
  <p className="v9-muted">{t('formRouting.reserved')}</p>
  <label className="v9-field"><span>{t('routes.duplicateTitle')}</span><select value={policy?.mode??''} disabled={disabled} onChange={e=>{const mode=e.target.value;change({...value,duplicateRolePolicy:mode?{mode:mode as NonNullable<ProbationForm['duplicateRolePolicy']>['mode'],...(mode==='named_alternate'?{alternateUserId:policy?.alternateUserId??null}:{})}:undefined});}}>
   <option value="">{t('formRouting.policyInherit')}</option>{(['escalate','sign_once','named_alternate'] as const).map(mode=><option key={mode} value={mode}>{t('routes.duplicateModes.'+mode)}</option>)}</select></label>
  {policy?.mode==='named_alternate'&&<label className="v9-field"><span>{t('routes.alternateSigner')}</span><select value={policy.alternateUserId??''} disabled={disabled} onChange={e=>change({...value,duplicateRolePolicy:{mode:'named_alternate',alternateUserId:e.target.value||null}})}><option value="">{t('choose')}</option>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label>}
  <p className="v9-muted">{t('routes.duplicateHelp')}</p>
 </section>;
}
