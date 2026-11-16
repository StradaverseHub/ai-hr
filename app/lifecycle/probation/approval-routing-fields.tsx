'use client';
import {useTranslations} from 'next-intl';
import {Plus,Trash2} from 'lucide-react';
import {PROBATION_APPROVAL_ACTIONS,PROBATION_APPROVAL_HOLDER_WHO,PROBATION_APPROVAL_PICKS,MAX_PROBATION_APPROVAL_PEOPLE,defaultProbationApprovals,probationApprovalChain,probationApprovalRouted,type ProbationApprovalRow,type ProbationForm} from '@/lib/probation-form';
const PARTS=['1','2','3'] as const;
type Option={id:string;name:string};
/** The shared routings and assignment groups the approver pickers offer (HR Automation readers). */
export type ApproverChoices={routings:Option[];groups:Option[]};
type WhoKind=typeof PROBATION_APPROVAL_HOLDER_WHO[number]|'routing'|'group'|'people';
const WHO_KINDS:WhoKind[]=[...PROBATION_APPROVAL_HOLDER_WHO,'routing','group','people'];
const whoKind=(who:string):WhoKind=>who.startsWith('routing:')?'routing':who.startsWith('group:')?'group':(who as WhoKind);
/** A row id for a new step: unique in the Part, never a core step or the Head of Department / PBP ids. */
function nextId(rows:readonly ProbationApprovalRow[]):string{for(let n=1;;n++){const id='step_'+n;if(!rows.some(row=>row.id===id))return id;}}
/**
 * Review and approval routing on a form version (handoff B3, owner mockup screen 10). Core steps are shown greyed and
 * cannot change; approval rows run by order (lower first), rows sharing an order in the order listed. Every save makes
 * a new version, so a published version never changes and a case keeps the routing of the version it started on.
 * Who: the Head of Department, PBP or Direct Superior (the case's holders), or a routing, an assignment group or named
 * people, of whom ONE person takes the step (any member or round robin) when the Line Manager submits.
 */
export function ApprovalRoutingFields({value,change,disabled,users,choices}:{value:ProbationForm;change:(value:ProbationForm)=>void;disabled:boolean;users:readonly Option[];choices?:ApproverChoices}){
 const t=useTranslations('probation');
 if(!value.approvals)return <section className="v9-panel v9-stack" aria-labelledby="probation-form-routing"><h3 id="probation-form-routing">{t('formRouting.title')}</h3><p className="v9-muted">{t('formRouting.legacy')}</p>
  <div><button type="button" className="v9-button" disabled={disabled} onClick={()=>change({...value,approvals:defaultProbationApprovals()})}>{t('formRouting.useForm')}</button></div></section>;
 const approvals=value.approvals,routings=choices?.routings??[],groups=choices?.groups??[];
 const setRows=(part:typeof PARTS[number],rows:ProbationApprovalRow[])=>change({...value,approvals:{...approvals,[part]:rows}});
 const policy=value.duplicateRolePolicy;
 const whoLabel=(row:ProbationApprovalRow)=>{const kind=whoKind(row.who);
  if(kind==='routing')return routings.find(r=>'routing:'+r.id===row.who)?.name??t('formRouting.whoKinds.routing');
  if(kind==='group')return groups.find(g=>'group:'+g.id===row.who)?.name??t('formRouting.whoKinds.group');
  return t('formRouting.whoKinds.'+kind);};
 return <section className="v9-panel v9-stack" aria-labelledby="probation-form-routing"><h3 id="probation-form-routing">{t('formRouting.title')}</h3><p className="v9-muted">{t('formRouting.help')}</p>
  <p className="v9-notice" role="note">{t('formRouting.resolveNote')}</p>
  {PARTS.map(part=>{const rows=approvals[part];
   return <fieldset key={part} className="v9-stack" data-part={part}><legend>{t('partTitle',{part})}</legend>
    <p className="v9-muted" data-core-steps>{t('formRouting.core',{steps:t(part==='1'?'formRouting.coreKpi':'formRouting.coreReview')})}</p>
    {probationApprovalChain(rows).map(row=>{const index=rows.indexOf(row),kind=whoKind(row.who),update=(patch:Partial<ProbationApprovalRow>)=>setRows(part,rows.map((item,i)=>i===index?{...item,...patch}:item));
     // Changing who: the Head of Department and PBP keep their role as the step id (as before); other steps a row id.
     const setKind=(next:WhoKind)=>{const who=next==='routing'?'routing:'+(routings[0]?.id??''):next==='group'?'group:'+(groups[0]?.id??''):next;
      const routed=probationApprovalRouted(who),id=who==='hod'||who==='pbp'?who:row.id==='hod'||row.id==='pbp'?nextId(rows):row.id;
      const {pick:_pick,userIds:_userIds,...rest}=row;void _pick;void _userIds;
      update({...rest,id,who,...(routed?{pick:row.pick??'any'}:{}),...(next==='people'?{userIds:[]}:{})} as ProbationApprovalRow);};
     const label=whoLabel(row);
     return <div className="v9-fields" key={row.id} data-approval-row={row.id}>
      <label className="v9-field"><span>{t('formRouting.order')}</span><input type="number" min={1} max={9} step={1} value={row.order} disabled={disabled} onChange={e=>update({order:Math.max(1,Math.min(9,Math.floor(Number(e.target.value)||1)))})}/></label>
      <label className="v9-field"><span>{t('formRouting.action')}</span><select value={row.action} disabled={disabled} onChange={e=>update({action:e.target.value as ProbationApprovalRow['action']})}>{PROBATION_APPROVAL_ACTIONS.map(action=><option key={action} value={action}>{t('formRouting.actions.'+action)}</option>)}</select></label>
      <label className="v9-field"><span>{t('formRouting.who')}</span><select value={kind} disabled={disabled} onChange={e=>setKind(e.target.value as WhoKind)}>{WHO_KINDS.filter(option=>option===kind||!(PROBATION_APPROVAL_HOLDER_WHO as readonly string[]).includes(option)||!rows.some(other=>other.who===option)).map(option=><option key={option} value={option} disabled={option==='routing'&&!routings.length||option==='group'&&!groups.length}>{t('formRouting.whoKinds.'+option)}</option>)}</select></label>
      {kind==='routing'&&<label className="v9-field"><span>{t('formRouting.routing')}</span><select value={row.who.slice(8)} disabled={disabled} onChange={e=>update({who:'routing:'+e.target.value})}>{!routings.some(r=>'routing:'+r.id===row.who)&&<option value={row.who.slice(8)}>{t('formRouting.missingChoice')}</option>}{routings.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
      {kind==='group'&&<label className="v9-field"><span>{t('formRouting.group')}</span><select value={row.who.slice(6)} disabled={disabled} onChange={e=>update({who:'group:'+e.target.value})}>{!groups.some(g=>'group:'+g.id===row.who)&&<option value={row.who.slice(6)}>{t('formRouting.missingChoice')}</option>}{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}
      {kind==='people'&&<label className="v9-field"><span>{t('formRouting.people')}</span><select multiple size={Math.min(6,Math.max(3,users.length))} value={row.userIds??[]} disabled={disabled} onChange={e=>update({userIds:Array.from(e.target.selectedOptions,option=>option.value).slice(0,MAX_PROBATION_APPROVAL_PEOPLE)})}>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label>}
      {probationApprovalRouted(row.who)&&<label className="v9-field"><span>{t('formRouting.pick')}</span><select value={row.pick??'any'} disabled={disabled} onChange={e=>update({pick:e.target.value as NonNullable<ProbationApprovalRow['pick']>})}>{PROBATION_APPROVAL_PICKS.map(pick=><option key={pick} value={pick}>{t('formRouting.picks.'+pick)}</option>)}</select></label>}
      <div className="v9-actions"><button type="button" className="v9-button" aria-label={t('formRouting.remove',{who:label})} disabled={disabled} onClick={()=>setRows(part,rows.filter((_,i)=>i!==index))}><Trash2 size={16}/></button></div>
     </div>;})}
    {!rows.length&&<p className="v9-muted">{t(part==='3'?'formRouting.partThreeRequired':'formRouting.none')}</p>}
    <div><button type="button" className="v9-button" disabled={disabled||rows.length>=10} onClick={()=>{const free=(['hod','pbp','superior'] as const).find(who=>!rows.some(row=>row.who===who));const order=Math.min(9,rows.reduce((max,row)=>Math.max(max,row.order),0)+1);
     setRows(part,[...rows,free?{id:free==='superior'?nextId(rows):free,order,action:'approve_sign',who:free}:{id:nextId(rows),order,action:'approve_sign',who:'people',pick:'any',userIds:[]}]);}}><Plus size={16}/>{t('formRouting.add')}</button></div>
   </fieldset>;})}
  <p className="v9-muted">{t('formRouting.reserved')}</p>
  <label className="v9-field"><span>{t('routes.duplicateTitle')}</span><select value={policy?.mode??''} disabled={disabled} onChange={e=>{const mode=e.target.value;change({...value,duplicateRolePolicy:mode?{mode:mode as NonNullable<ProbationForm['duplicateRolePolicy']>['mode'],...(mode==='named_alternate'?{alternateUserId:policy?.alternateUserId??null}:{})}:undefined});}}>
   <option value="">{t('formRouting.policyInherit')}</option>{(['escalate','sign_once','named_alternate'] as const).map(mode=><option key={mode} value={mode}>{t('routes.duplicateModes.'+mode)}</option>)}</select></label>
  {policy?.mode==='named_alternate'&&<label className="v9-field"><span>{t('routes.alternateSigner')}</span><select value={policy.alternateUserId??''} disabled={disabled} onChange={e=>change({...value,duplicateRolePolicy:{mode:'named_alternate',alternateUserId:e.target.value||null}})}><option value="">{t('choose')}</option>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label>}
  <p className="v9-muted">{t('routes.duplicateHelp')}</p>
 </section>;
}
