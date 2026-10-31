'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {PersonnelImportValues} from '@/components/personnel-import-values';
import {personnelColumnLabel} from '@/lib/personnel-import-contract';
import {Button,Card} from '@/components/ui';
import {BANK_IMPORT_CHUNK_BYTES,BANK_IMPORT_MAX_BYTES,bankImportActive,bankImportPercent,type BankImportProgress} from '@/lib/bank-import-job';
import {IMPORT_FILE_ACCEPT} from '@/lib/import-file';
import type {SectionRowResult} from '@/lib/import-sections';
const endpoint='/admin/personnel/import/bank-statutory/jobs';
type Row={ordinal:number;preview:SectionRowResult|null;state:string;error:string|null};
async function jsonRequest(url:string,init?:RequestInit){
 const response=await fetch(url,{...init,cache:'no-store'}),payload=await response.json().catch(()=>null);
 if(!response.ok||!payload)throw new Error(payload?.error??'The import connection was interrupted. Reopen progress before retrying.');
 return payload;
}
export function BankImportProgress(){
 const t=useTranslations('people.import'),j=useTranslations('people.import.background'),labels=useTranslations();
 const fieldLabel=(column:string)=>personnelColumnLabel(column,'employee',(key,fallback)=>labels.has(key)?labels(key):fallback);
 const [job,setJob]=useState<BankImportProgress|null>(null),[jobs,setJobs]=useState<BankImportProgress[]>([]),[rows,setRows]=useState<Row[]>([]),[page,setPage]=useState(0),[checkedAt,setCheckedAt]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[paste,setPaste]=useState(''),[duplicate,setDuplicate]=useState(false);
 const choosing=useRef(false),input=useRef<HTMLInputElement>(null);
 useEffect(()=>{let alive=true;jsonRequest(endpoint).then(p=>{if(alive){setJobs(p.jobs);setJob(p.jobs.find((v:BankImportProgress)=>bankImportActive(v.state))??p.jobs[0]??null);}}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[]);
 useEffect(()=>{
  if(!job?.id)return;let alive=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{let again=true;try{const data=await jsonRequest(`${endpoint}/${job.id}?page=${page}`);if(alive){setJob(data.job);setRows(data.rows);setCheckedAt(Date.now());again=bankImportActive(data.job.state);}}catch(e){if(alive)setError((e as Error).message);}finally{if(alive&&again)timer=setTimeout(poll,2000);}};
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[job?.id,page]);
 const upload=async(file:File)=>{
  if(choosing.current)return;choosing.current=true;setBusy(true);setError('');setDuplicate(false);setPage(0);
  try{
   if(file.size>BANK_IMPORT_MAX_BYTES)throw new Error(j('limit'));
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
   const admitted=await jsonRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,bytes:file.size,hash})});
   setJob(admitted.job);setRows([]);setJobs(old=>[admitted.job,...old.filter(v=>v.id!==admitted.job.id)]);
   if(admitted.existing&&admitted.job.state!=='uploading'){setDuplicate(true);return;}
   for(let offset=0,part=0;offset<file.size;offset+=BANK_IMPORT_CHUNK_BYTES,part++){
    await jsonRequest(`${endpoint}/${admitted.job.id}?part=${part}`,{method:'PUT',body:file.slice(offset,offset+BANK_IMPORT_CHUNK_BYTES)});
    setJob(old=>old&&old.id===admitted.job.id?{...old,uploadedBytes:Math.min(file.size,offset+BANK_IMPORT_CHUNK_BYTES)}:old);
   }
   const queued=await jsonRequest(`${endpoint}/${admitted.job.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'validate'})});setJob(queued.job);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);choosing.current=false;if(input.current)input.current.value='';}
 };
 const command=async(value:'confirm'|'cancel')=>{
  if(!job||choosing.current)return;choosing.current=true;setBusy(true);setError('');
  try{const result=await jsonRequest(`${endpoint}/${job.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:value})});setJob(result.job);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);choosing.current=false;}
 };
 const stateLabels:Record<BankImportProgress['state'],string>={uploading:j('uploading'),queued:j('queued'),validating:j('validating'),ready:j('ready'),importing:j('importing'),completed:j('completed'),failed:j('failed'),cancelled:j('cancelled')};
 const progress=job?bankImportPercent(job):0;
 return <div className="space-y-4">
  <Card className="space-y-3 p-5">
   <p className="text-sm">{j('help')}</p><p className="text-xs text-muted-foreground">{j('limit')}</p>
   <label className="block text-sm font-medium" htmlFor="bank-import-file">{t('uploadFile')}</label>
   <input id="bank-import-file" ref={input} type="file" accept={IMPORT_FILE_ACCEPT} disabled={busy||loading} onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file);}} className="block max-w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-2"/>
   <details className="text-sm"><summary className="cursor-pointer">{j('paste')}</summary><textarea aria-label={j('paste')} value={paste} disabled={busy} onChange={event=>setPaste(event.target.value)} rows={5} className="my-3 w-full rounded border border-border bg-background p-2 font-mono text-xs"/><Button variant="secondary" disabled={busy||!paste.trim()} onClick={()=>void upload(new File([paste],'pasted-bank-statutory.csv',{type:'text/csv'}))}>{j('checkPaste')}</Button></details>
   {loading&&<p role="status" className="text-sm text-muted-foreground">{j('loading')}</p>}
   {busy&&!job&&<p role="status" className="text-sm text-muted-foreground">{j('preparing')}</p>}
  </Card>
  {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
  {duplicate&&<p role="status" className="text-sm text-muted-foreground">{j('duplicate')}</p>}
  {jobs.length>1&&<label className="block text-sm">{j('recent')}<select className="ml-3 max-w-full rounded border border-border bg-background p-2" value={job?.id??''} disabled={busy} onChange={event=>{setPage(0);setRows([]);setJob(jobs.find(v=>v.id===event.target.value)??null);}}>{jobs.map(v=><option key={v.id} value={v.id}>{v.sourceName} · {new Date(v.createdAt).toLocaleString()}</option>)}</select></label>}
  {job&&<Card className="space-y-4 p-5">
   <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="break-all text-sm font-semibold">{job.sourceName}</h3><span role="status" className="text-sm">{stateLabels[job.state]}</span></div>
   {bankImportActive(job.state)&&job.state!=='ready'&&<><progress aria-label={stateLabels[job.state]} value={progress} max={100} className="h-2 w-full accent-primary"/><p className="text-xs text-muted-foreground">{job.state==='uploading'?j('uploadCount',{done:job.uploadedBytes,total:job.sourceBytes}):job.state==='importing'?j('savedCount',{saved:job.saved,done:job.processed,total:job.total}):j('validationCount',{done:job.validated,total:job.total})}</p></>}
   {['queued','validating','importing'].includes(job.state)&&<p className="text-xs text-muted-foreground">{checkedAt-Date.parse(job.updatedAt)>90_000?j('waiting'):j('backgroundHelp')}</p>}
   {job.total>0&&<p className="text-sm">{j('summary',{valid:job.valid,invalid:job.invalid,unchanged:job.unchanged})}</p>}
   {job.state==='ready'&&<div className="flex flex-wrap gap-3"><Button disabled={busy||job.valid===0} onClick={()=>void command('confirm')}>{j('confirm',{count:job.valid})}</Button><Button variant="secondary" disabled={busy} onClick={()=>void command('cancel')}>{j('cancel')}</Button><p className="w-full text-xs text-muted-foreground">{t('step4Hint')}</p></div>}
   {job.state==='uploading'&&!busy&&<><p className="text-sm">{j('resumeUpload')}</p><Button variant="secondary" onClick={()=>void command('cancel')}>{j('cancel')}</Button></>}
   {job.state==='completed'&&<p role="status" className="text-sm font-medium">{j('result',{saved:job.saved,failed:job.failed+job.invalid})}</p>}
   {job.error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{job.error}</p>}
   {job.invalid+job.failed>0&&['ready','completed','failed','cancelled'].includes(job.state)&&<a href={`${endpoint}/${job.id}/errors`} className="inline-block text-sm text-primary underline">{t('downloadErrors')}</a>}
   {job.attemptId&&<Link href={`/admin/personnel/import/history/${job.attemptId}`} className="inline-block text-sm text-primary underline">{t('viewImportHistoryEntry')}</Link>}
   {rows.some(r=>r.preview)&&<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-2">#</th><th className="p-2">{t('colEmployeeCode')}</th><th className="p-2">{t('colEmployee')}</th><th className="p-2">{t('colChanges')}</th><th className="p-2">{t('colResult')}</th></tr></thead><tbody>{rows.map(row=><tr key={row.ordinal} className="border-b border-border"><td className="p-2 tabular-nums">{row.ordinal}</td><td className="p-2">{row.preview?.employeeCode}</td><td className="p-2">{row.preview?.employeeName}</td><td className="p-2">{row.preview?.changes.map(fieldLabel).join(', ')}<PersonnelImportValues values={row.preview?.proposed} sheet="employee"/></td><td className="p-2">{row.error??(row.preview?.errors.length?row.preview.errors.join('; '):row.state==='applied'?j('saved'):row.state==='unchanged'||row.state==='skipped'?t('verdictSkip'):row.state==='invalid'?t('verdictBlocked'):t('ready'))}</td></tr>)}</tbody></table><div className="mt-3 flex items-center justify-between gap-3"><Button variant="secondary" disabled={page===0} onClick={()=>setPage(p=>p-1)}>{j('previous')}</Button><span className="text-xs">{j('page',{page:page+1,total:Math.max(1,Math.ceil(job.total/100))})}</span><Button variant="secondary" disabled={(page+1)*100>=job.total} onClick={()=>setPage(p=>p+1)}>{j('next')}</Button></div></div>}
  </Card>}
 </div>;
}
