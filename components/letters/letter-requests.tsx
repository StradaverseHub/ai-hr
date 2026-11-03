import Link from 'next/link';
import {Button,Card,Field,StatusBadge,btnPrimary,inputCls} from '@/components/ui';
import {LETTER_REQUEST_LIMITS,type LetterRequestOption,type RequestableLetterType,type StaffLetterRequest} from '@/core/letter-requests';
import {declineLetterRequestAction} from '@/app/letters/generate/actions';

export type LetterRequestQueueLabels=Readonly<{title:string;intro:string;empty:string;unavailable:string;employee:string;purpose:string;requestedOn:(date:string)=>string;
 prepare:string;prepareUnavailable:string;decline:string;declineReason:string;declineHelp:string;employeeMessage:string;employeeMessageHelp:string;declineSubmit:string;inProgress:string;
 status:Readonly<Record<StaffLetterRequest['status'],string>>}>;

/** AI v2 Phase 1 slice 3 — the employee letter requests of one company, on the generate page, for HR holding `generate`.
 * "Prepare letter" opens the existing generate flow on the request's employee and template (the template's published
 * version now); HR writes, approves and issues the letter there as today. "Decline" needs a reason, which stays with HR,
 * and takes an optional "Message to the employee", shown to the employee with the declined status. Rendered on the
 * server; every action re-checks. */
/** `all` (Today's link, `requests=all`): the requests of every company the user may handle; each names its company when
 * there is more than one (`companyNames`), and Decline returns to the same list. */
export function LetterRequestQueue({companyId,requests,labels,formatDate,all=false,companyNames,companyLabel}:{companyId:string;requests:readonly StaffLetterRequest[]|null;labels:LetterRequestQueueLabels;formatDate:(date:Date)=>string;
 all?:boolean;companyNames?:ReadonlyMap<string,string>;companyLabel?:string}){
 return <section id="letter-requests" className="space-y-3" aria-labelledby="letter-requests-title">
  <h2 id="letter-requests-title" className="font-semibold">{labels.title}</h2>
  <p className="text-sm text-muted-foreground">{labels.intro}</p>
  {requests===null?<Card role="note" className="p-5 text-sm text-muted-foreground">{labels.unavailable}</Card>
   :requests.length===0?<Card className="p-5 text-sm text-muted-foreground">{labels.empty}</Card>
   :<ul className="space-y-3">{requests.map(request=><li key={request.id}><Card className="space-y-3 p-4" data-letter-request={request.status}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1">
     <h3 className="break-words font-semibold">{request.letterTypeName}</h3>
     {companyNames&&companyLabel&&<p data-letter-request-company className="break-words text-sm">{companyLabel}: {companyNames.get(request.companyId)??'—'}</p>}
     <p className="break-words text-sm">{labels.employee}: {request.employeeName??'—'}{request.employeeCode?' · '+request.employeeCode:''}</p>
     <p className="text-xs text-muted-foreground">{labels.requestedOn(formatDate(request.createdAt))}</p></div>
     <StatusBadge status={'letter_request_'+request.status} label={labels.status[request.status]}/></div>
    {request.purpose&&<p className="break-words rounded-md bg-muted p-3 text-sm"><span className="font-medium">{labels.purpose}:</span> {request.purpose}</p>}
    {request.status==='in_progress'&&<p className="text-sm text-muted-foreground">{labels.inProgress}</p>}
    <div className="flex flex-wrap items-start gap-3">
     {request.publishedVersionId
      ?<Link href={'/letters/generate/new?'+new URLSearchParams({versionId:request.publishedVersionId,requestId:request.id})} className={`${btnPrimary} inline-flex min-h-11 items-center`}>{labels.prepare}</Link>
      :<p className="text-sm text-muted-foreground">{labels.prepareUnavailable}</p>}
     <details className="min-w-0 flex-1 basis-64"><summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">{labels.decline}</summary>
      <form action={declineLetterRequestAction} className="mt-3 space-y-3">
       <input type="hidden" name="companyId" value={all?request.companyId:companyId}/><input type="hidden" name="requestId" value={request.id}/><input type="hidden" name="expectedVersion" value={request.version}/>
       {all&&<input type="hidden" name="requests" value="all"/>}
       <Field label={labels.declineReason}><textarea name="reason" required maxLength={LETTER_REQUEST_LIMITS.reasonChars} rows={3} className={inputCls+' h-auto min-h-20 py-2'}/></Field>
       <p className="text-xs text-muted-foreground">{labels.declineHelp}</p>
       <Field label={labels.employeeMessage}><textarea name="employeeMessage" maxLength={LETTER_REQUEST_LIMITS.messageChars} rows={3} aria-describedby={'letter-request-message-help-'+request.id} className={inputCls+' h-auto min-h-20 py-2'}/></Field>
       <p id={'letter-request-message-help-'+request.id} className="text-xs text-muted-foreground">{labels.employeeMessageHelp}</p>
       <Button type="submit" variant="outline" className="pointer-coarse:min-h-11">{labels.declineSubmit}</Button>
      </form></details>
    </div>
   </Card></li>)}</ul>}
 </section>;
}

export type LetterRequestOptionLabels=Readonly<{title:string;intro:string;empty:string;unavailable:string;allow:(name:string)=>string;save:string}>;
/** Letter settings: "Employees may request" for each published template of the company, default off. Rendered on the
 * server; the action re-checks `settings`. */
export function LetterRequestOptionsForm({companyId,options,labels,action}:{companyId:string;options:readonly LetterRequestOption[]|null;labels:LetterRequestOptionLabels;
 action:(form:FormData)=>Promise<void>}){
 return <Card id="letter-request-options" className="space-y-4 p-5">
  <h2 className="font-semibold">{labels.title}</h2><p className="text-sm text-muted-foreground">{labels.intro}</p>
  {options===null?<p role="note" className="text-sm text-muted-foreground">{labels.unavailable}</p>
   :options.length===0?<p className="text-sm text-muted-foreground">{labels.empty}</p>
   :<form action={action} className="space-y-3"><input type="hidden" name="companyId" value={companyId}/>
    <ul className="space-y-1">{options.map(option=><li key={option.templateId}><input type="hidden" name="templateId" value={option.templateId}/>
     <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name="requestable" value={option.templateId} defaultChecked={option.requestable} className="size-4 shrink-0"/>
      <span className="min-w-0 break-words">{labels.allow(option.name)} <span className="text-muted-foreground">· {option.code}</span></span></label></li>)}</ul>
    <Button type="submit" className="pointer-coarse:min-h-11">{labels.save}</Button></form>}
 </Card>;
}

export type LetterRequestFormLabels=Readonly<{title:string;description:string;type:string;choose:string;typeInCompany:(type:string,company:string)=>string;
 purpose:string;purposeHelp:string;submit:string;cancel:string;error:string|null}>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const choiceOf=(type:RequestableLetterType)=>type.employmentId+'.'+type.templateId;
/** "Request a letter" on My Letters: the letter type, from the templates the person's company has opened for employee
 * requests only, and an optional purpose in the person's own words. HR prepares and issues the letter; this form writes
 * no letter content. `preselect` (from the chat card's Edit) only chooses a type the person may request. */
export function LetterRequestForm({types,labels,preselect,action}:{types:readonly RequestableLetterType[];labels:LetterRequestFormLabels;preselect?:string;
 action:(form:FormData)=>Promise<void>}){
 const companies=new Set(types.map(type=>type.companyId)).size;
 const chosen=typeof preselect==='string'&&UUID.test(preselect)?types.find(type=>type.templateId===preselect):undefined;
 return <Card id="request-letter" className="p-4 sm:p-6"><section className="space-y-4" aria-labelledby="request-letter-title">
  <div className="space-y-1"><h2 id="request-letter-title" className="font-semibold">{labels.title}</h2><p className="text-sm text-muted-foreground">{labels.description}</p></div>
  {labels.error&&<p role="alert" className="rounded-md border border-destructive p-4 text-sm text-destructive">{labels.error}</p>}
  <form action={action} className="space-y-5">
   <Field label={labels.type}><select name="choice" required defaultValue={chosen?choiceOf(chosen):''} className={`${inputCls} min-h-11`}>
    <option value="" disabled>{labels.choose}</option>
    {types.map(type=><option key={choiceOf(type)} value={choiceOf(type)}>{companies>1?labels.typeInCompany(type.name,type.companyName):type.name}</option>)}
   </select></Field>
   <Field label={labels.purpose}><textarea name="purpose" maxLength={LETTER_REQUEST_LIMITS.purposeChars} rows={3} className={inputCls+' h-auto min-h-24 py-2'}/></Field>
   <p className="-mt-3 text-xs text-muted-foreground">{labels.purposeHelp}</p>
   <div className="flex flex-wrap items-center gap-3"><Button type="submit" className="pointer-coarse:min-h-11">{labels.submit}</Button>
    <Link href="/me/letters" className="inline-flex min-h-11 items-center text-sm font-medium text-muted-foreground hover:text-foreground">{labels.cancel}</Link></div>
  </form>
 </section></Card>;
}
