'use client';
import {useState} from 'react';
import {recordNativeOutcomeAction} from '../../app/(app)/assistant/native-outcome-actions';
export type NativeOutcomeFormMessages=Readonly<{choose:string;consent:string;save:string;pending:string;recover:string}>;
/** No auto retry after transport uncertainty. Reloading only discovers metadata; it records nothing. */
export function NativeOutcomeForm({jobId,nonce,options,messages}:{jobId:string;nonce:string;options:readonly{value:string;label:string}[];messages:NativeOutcomeFormMessages}){
 const [reference,setReference]=useState(''),[consented,setConsented]=useState(false),[submitted,setSubmitted]=useState(false);
 return <form action={recordNativeOutcomeAction} onSubmit={event=>{if(submitted||!reference||!consented){event.preventDefault();return;}setSubmitted(true);}} className="space-y-3">
  <input type="hidden" name="jobId" value={jobId}/><input type="hidden" name="nonce" value={nonce}/>
  {/* Keep successful controls present while the visible controls freeze after explicit submission. */}
  <input type="hidden" name="reference" value={reference}/><input type="hidden" name="consented" value={consented?'yes':'no'}/>
  <label className="block text-sm">{messages.choose}<select value={reference} disabled={submitted} required onChange={event=>{setReference(event.target.value);setConsented(false);}} className="mt-1 block min-h-11 w-full rounded-md border bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
   <option value="">{messages.choose}</option>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>
  <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={consented} disabled={submitted||!reference} required onChange={event=>setConsented(event.target.checked)} className="h-5 w-5"/><span>{messages.consent}</span></label>
  <button type="submit" disabled={!reference||!consented||submitted} className="min-h-11 rounded-md border px-4 py-2 text-sm disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{messages.save}</button>
  {submitted&&<p role="status" className="text-sm">{messages.pending}</p>}
  <a href={'/assistant?governed='+encodeURIComponent(jobId)} className="inline-flex min-h-11 items-center px-2 text-sm underline">{messages.recover}</a>
 </form>;
}
