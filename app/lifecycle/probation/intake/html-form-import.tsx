'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {ActionButton} from '@/components/ui/action-button';
import type {ProbationFormImportResult,ProbationFormImportRow} from '@/packs/probation/service';
import {DraftGuard} from '../draft-guard';

const MAX_FILES=50,MAX_BYTES=2*1024*1024,ENDPOINT='/lifecycle/probation/intake/saved-forms';
type Row={key:string;file:File;pdf:boolean;preview:ProbationFormImportResult|null;outcome:ProbationFormImportResult|null;busy:boolean};
const refused=(file:File,code:ProbationFormImportResult['code']):ProbationFormImportResult=>({file:file.name,result:'refused',code,warnings:[]});

/**
 * Step 1 of Intake and activation (handoff §5 Part C, prototype IntakePage): choose saved v22.9.26 forms, preview what the
 * server read from each, then import the ready ones. Each file goes to the server on its own request and transaction, so
 * one bad file never blocks the others; the server authorises every file against the matched employee.
 */
export function HtmlFormImport({companyId,imports}:{companyId:string;imports:ProbationFormImportRow[]}){
 const t=useTranslations('probation.intake.htmlImport'),router=useRouter(),input=useRef<HTMLInputElement>(null);
 const[rows,setRows]=useState<Row[]>([]),[reading,setReading]=useState(false),[importing,setImporting]=useState(false),[checked,setChecked]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
 const send=async(file:File,mode:'preview'|'import'):Promise<ProbationFormImportResult>=>{
  const body=new FormData();body.set('company',companyId);body.set('mode',mode);body.set('file',file);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  try{const response=await fetch(ENDPOINT,{method:'POST',body,signal:controller.signal});const json:unknown=response.ok?await response.json():null;
   if(typeof json==='object'&&json!==null&&'ok' in json&&json.ok===true&&'result' in json)return json.result as ProbationFormImportResult;
   return refused(file,response.status===413?'too_large':'not_saved');}
  catch{return refused(file,'not_saved');}
  finally{clearTimeout(timer);}
 };
 const choose=async(list:File[])=>{
  setError('');setDone(false);setChecked(false);if(input.current)input.current.value='';
  if(!list.length)return;
  if(list.length>MAX_FILES){setRows([]);setError(t('tooMany',{max:MAX_FILES}));return;}
  const next:Row[]=list.map((file,i)=>({key:i+':'+file.name,file,pdf:/\.pdf$/i.test(file.name),preview:null,outcome:null,busy:false}));
  setRows(next);setReading(true);
  for(const row of next){
   if(row.pdf)continue;
   const preview=row.file.size>MAX_BYTES?refused(row.file,'too_large'):await send(row.file,'preview');
   setRows(old=>old.map(r=>r.key===row.key?{...r,preview}:r));
  }
  setReading(false);
 };
 const ready=rows.filter(r=>!r.pdf&&r.preview?.result==='previewed'&&!r.outcome);
 const run=async()=>{
  if(!checked||!ready.length||importing)return;
  setImporting(true);
  for(const row of ready){
   setRows(old=>old.map(r=>r.key===row.key?{...r,busy:true}:r));
   const outcome=await send(row.file,'import');
   setRows(old=>old.map(r=>r.key===row.key?{...r,busy:false,outcome}:r));
  }
  setImporting(false);setDone(true);setChecked(false);router.refresh();
 };
 const refusal=(r:ProbationFormImportResult)=>r.code==='excluded'?t('refusals.excluded',{reason:t.has('exclusionReasons.'+r.reason)?t('exclusionReasons.'+r.reason):t('exclusionReasons.unavailable')}):r.code==='wrong_version'?t('refusals.wrong_version',{version:r.version??'—'}):r.code==='invalid_field'?t('refusals.invalid_field',{field:r.field??'—'}):t.has('refusals.'+r.code)?t('refusals.'+r.code):t('refusals.not_saved');
 const found=(r:ProbationFormImportResult)=>(r.summary??[]).map(s=>s.part===1?t('partSummary.part1',{kpis:s.kpis??0,signatures:s.signatures,status:t('partStatus.'+s.status)}):t('partSummary.review',{part:s.part,ratings:s.managerRatings??0,signatures:s.signatures,status:t('partStatus.'+s.status)})).join(' · ');
 const pending=rows.length>0&&!done;
 return <section className="v9-panel v9-stack" aria-labelledby="probation-html-import"><DraftGuard dirty={pending&&ready.length>0}/>
  <h2 id="probation-html-import">{t('title')}</h2><p className="v9-muted">{t('help')}</p>
  <div className="probation-actions">
   <button type="button" className="v9-button" disabled={reading||importing} onClick={()=>input.current?.click()}>{t('choose')}</button>
   <input ref={input} type="file" multiple accept=".html,.htm,.pdf,text/html,application/pdf" hidden aria-label={t('fileLabel')} onChange={e=>void choose([...(e.target.files??[])])}/>
   <span className="v9-muted" role="status">{reading?t('reading'):rows.length?t('read',{count:rows.length}):t('noFile')}</span>
  </div>
  {error&&<p role="alert" className="v9-notice v9-error">{error}</p>}
  {rows.length>0&&<div className="probation-list-table"><table><thead><tr><th>{t('columns.file')}</th><th>{t('columns.found')}</th><th>{t('columns.result')}</th></tr></thead><tbody>
   {rows.map(row=>{const p=row.preview,o=row.outcome;return <tr key={row.key}>
    <td data-label={t('columns.file')}><strong>{row.file.name}</strong>{p?.employee&&<p className="v9-muted">{p.employee.name} · {p.employee.id}</p>}</td>
    <td data-label={t('columns.found')}>{row.pdf?t('pdf'):p?.result==='previewed'?found(p):'—'}</td>
    <td data-label={t('columns.result')}>{row.pdf?<span className="v9-badge">{t('statuses.skipped')}</span>
     :!p?<span className="v9-muted">{t('reading')}</span>
     :row.busy?<span className="v9-muted">{t('statuses.importing')}</span>
     :o?<ResultCell result={o} refusal={refusal}/>
     :p.result==='refused'?<><span className="v9-badge v9-badge-red">{t('statuses.refused')}</span><p>{refusal(p)}</p></>
     :<><span className={p.warnings.length?'v9-badge v9-badge-amber':'v9-badge'}>{t(p.warnings.length?'statuses.warning':'statuses.ready')}</span>{p.warnings.map(w=><p key={w} className="v9-muted">{w}</p>)}</>}</td>
   </tr>;})}
  </tbody></table></div>}
  {pending&&<><label><input type="checkbox" checked={checked} disabled={reading||importing||!ready.length} onChange={e=>setChecked(e.target.checked)}/> {t('confirm')}</label>
   <div><ActionButton guardNavigation aria-busy={importing} type="button" className="v9-button v9-button-primary" disabled={!checked||reading||importing||!ready.length} onClick={()=>void run()}>{importing?t('statuses.importing'):t('import',{count:ready.length})}</ActionButton></div></>}
  {done&&<p role="status" className="v9-notice">{t('done')}</p>}
  <details><summary>{t('historyTitle')} ({imports.length})</summary>
   {!imports.length?<p className="v9-muted">{t('historyEmpty')}</p>:<ul className="v9-list">{imports.map(row=><li key={row.id}>
    <a className="v9-button" href={ENDPOINT+'/'+row.id} download>{row.fileName}</a> <span>{row.employeeName} · {row.employeeCode??'—'} · {t('statuses.'+row.result)} · {row.importedAt.slice(0,10)} · {row.importedBy}</span>
   </li>)}</ul>}
  </details>
 </section>;
}

function ResultCell({result,refusal}:{result:ProbationFormImportResult;refusal:(r:ProbationFormImportResult)=>string}){
 const t=useTranslations('probation.intake.htmlImport');
 if(result.result==='refused')return <><span className="v9-badge v9-badge-red">{t('statuses.refused')}</span><p>{refusal(result)}</p></>;
 const kind=result.result==='unchanged'?'unchanged':result.result==='staged'?'staged':'merged';
 return <><span className="v9-badge">{t('statuses.'+kind)}</span><p>{t('resultHelp.'+kind)}</p>
  {kind==='merged'&&<ul className="v9-list">{(result.parts??[]).filter(p=>p.applied!=='nothing'&&p.applied!=='staged').map(p=><li key={p.part}>{t('applied.'+p.applied,{part:p.part})}</li>)}</ul>}</>;
}

/** In an employee's intake review: what a staged saved form said, so the PBP maps each Part with the existing rules. */
export function ImportedFormFindings({imports}:{imports:ProbationFormImportRow[]}){
 const t=useTranslations('probation.intake.htmlImport');
 if(!imports.length)return null;
 return <section className="v9-notice v9-stack"><h3>{t('candidateTitle')}</h3><p>{t('candidateHelp')}</p><ul className="v9-list">{imports.map(row=><li key={row.id}>
  <a href={ENDPOINT+'/'+row.id} download>{row.fileName}</a>: {row.summary.map(s=>t('candidatePart',{part:s.part,status:t('partStatus.'+s.status)})).join(' · ')}
 </li>)}</ul></section>;
}
