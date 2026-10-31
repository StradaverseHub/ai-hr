"use client";
import {useState} from 'react';
import {inputCls} from '../ui';
type CandidateChoice=Readonly<{value:string;label:string;personalSignals:boolean|null}>;
type CompanyChoice=Readonly<{id:string;name:string}>;
type Scope='user'|'company'|'tenant';
/** WP11 (R5): the approver chooses who a promotion applies to. Metadata only; the server re-checks the
 * scope, the company's tenant and the candidate's signal provenance before publishing anything. The
 * company select is rendered (and so posted) only for company scope. */
export function SpecialistPromotionChoices({candidates,companies,messages}:{candidates:readonly CandidateChoice[];companies:readonly CompanyChoice[];
 messages:Readonly<{chooseCandidate:string;scopeLegend:string;scopeUser:string;scopeCompany:string;scopeTenant:string;company:string;scopeHint:string;scopeSignalsOnly:string}>}){
 const [candidateId,setCandidateId]=useState(candidates[0]?.value??''),[scope,setScope]=useState<Scope>('user');
 // Unknown provenance is treated like personal signals (owner-only), but only a known fact is explained.
 const selected=candidates.find(row=>row.value===candidateId),ownerOnly=selected?.personalSignals!==false,personal=selected?.personalSignals===true;
 const options:readonly [Scope,string][]=[['user',messages.scopeUser],['company',messages.scopeCompany],['tenant',messages.scopeTenant]];
 return <>
  <label className="block text-sm">{messages.chooseCandidate}<select name="candidateId" required value={candidateId} onChange={event=>{const next=event.target.value;setCandidateId(next);if(candidates.find(row=>row.value===next)?.personalSignals!==false)setScope('user');}} className={`${inputCls} mt-1 min-h-11 w-full`}>{candidates.map(row=><option key={row.value} value={row.value}>{row.label}</option>)}</select></label>
  <fieldset className="space-y-2"><legend className="text-sm">{messages.scopeLegend}</legend>
   <div className="flex flex-col gap-1">{options.map(([value,label])=><label key={value} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="scope" value={value} checked={scope===value} disabled={value!=='user'&&(ownerOnly||(value==='company'&&!companies.length))} onChange={()=>setScope(value)}/><span>{label}</span></label>)}</div>
   {scope==='company'&&<label className="block text-sm">{messages.company}<select name="companyId" required defaultValue={companies[0]?.id} className={`${inputCls} mt-1 min-h-11 w-full`}>{companies.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
  </fieldset>
  <p className="text-xs text-muted-foreground">{messages.scopeHint}</p>
  {personal&&<p className="text-xs text-muted-foreground">{messages.scopeSignalsOnly}</p>}
 </>;
}
