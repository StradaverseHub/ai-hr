'use client';
import {useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import {parseCsv} from '@/lib/csv';
import {encodePolicyGrid,policyGridIssues,policyGridRows,policyGridWidth,type RewardPolicyGridKind} from '@/packs/rewards/policy-grid-validation';
import {loadPreviousRewardPolicyMatrices} from './policy-grid-actions';
import {useRewardPolicyYear} from './policy-year-context';
type Previous=Awaited<ReturnType<typeof loadPreviousRewardPolicyMatrices>>;
const headers:Record<RewardPolicyGridKind,string[]>={ranges:['Grade','Minimum','Midpoint','Maximum'],bonusMatrix:['Grade','UA','BE','ME','AE','OU'],branchFactors:['Segment','UA','BE','ME','AE','OU']};
type GridProps={kind:RewardPolicyGridKind;matrix:Record<string,readonly number[]>;year:number;onRowsChange?:(rows:string[][])=>void};
export function PolicyMatrixGrid(props:GridProps){const year=useRewardPolicyYear(props.year);return <PolicyMatrixGridDraft key={`${props.kind}:${year}`} {...props} year={year}/>;}
function PolicyMatrixGridDraft({kind,matrix,year,onRowsChange}:GridProps){
 const t=useTranslations('rewards.policyGrids');
 const [rows,setRows]=useState(()=>policyGridRows(kind,matrix)),[proposal,setProposal]=useState<string[][]|null>(null),[previous,setPrevious]=useState<Previous|null>(null),[sourceYear,setSourceYear]=useState(year),[busy,setBusy]=useState(false),[error,setError]=useState(false),file=useRef<HTMLInputElement>(null);
 const issues=policyGridIssues(kind,rows),columns=headers[kind];
 const invalid=(name:string,col:number)=>issues.some(issue=>issue.row===name&&issue.column===col);
 async function upload(input:File){
  setError(false);setBusy(true);setProposal(null);
  try{
   if(!input.name.toLowerCase().endsWith('.xlsx')||input.size>2*1024*1024)throw new Error();
   const {workbookToCsvText}=await import('@/lib/spreadsheet');
   const text=await workbookToCsvText(await input.arrayBuffer());
   const parsed=parseCsv(text),actual=(parsed[0]??[]).map(value=>value.trim().toLowerCase()),records=parsed.slice(1);
   const expected=columns.map(value=>value.toLowerCase());
   if(actual.length!==expected.length||actual.some((value,index)=>value!==expected[index])||!records.length||records.length>200||records.some(row=>row.length!==expected.length))throw new Error();
   const proposed=records.map(record=>record.map(value=>value.trim()));
   if(kind==='ranges'&&!proposed.some(row=>row[0]==='23'))proposed.push(['23','','','']);
   if(kind!=='branchFactors'&&policyGridIssues(kind,proposed).some(issue=>issue.column===0))throw new Error();
   setProposal(proposed);
  }catch{setError(true);}finally{setBusy(false);if(file.current)file.current.value='';}
 }
 const selectedYear=()=>{const input=file.current?.form?.elements.namedItem('year');return input instanceof HTMLInputElement?Number(input.value):year;};
 async function copy(){setBusy(true);setError(false);const requested=selectedYear();try{const choices=await loadPreviousRewardPolicyMatrices(requested);if(selectedYear()!==requested){setError(true);return;}setSourceYear(requested);setPrevious(choices);}catch{setError(true);}finally{setBusy(false);}}
 const changeRows=(next:string[][])=>{setRows(next);onRowsChange?.(next);};
 const update=(index:number,column:number,value:string)=>changeRows(rows.map((row,i)=>i===index?row.map((cell,c)=>c===column?value:cell):row));
 const proposalIssues=proposal?policyGridIssues(kind,proposal):[];
 return <section className="space-y-3" aria-label={t(kind)}>
  <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">{t(kind)}</h3><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={()=>file.current?.click()}>{t('import')}</Button><Button type="button" variant="outline" disabled={busy||year<=2000} onClick={()=>{void copy();}}>{t('copy')}</Button></div></div>
  <input ref={file} type="file" accept=".xlsx" className="sr-only" aria-label={t('import')} onChange={event=>{if(event.target.files?.[0])void upload(event.target.files[0]);}}/>
  <p className="text-xs text-muted-foreground">{t('columns',{columns:columns.join(', ')})}</p>
  {error&&<p role="alert" className="text-sm text-destructive">{t('fileError')}</p>}
  {previous&&<div className="space-y-2 rounded-md border p-3"><p className="text-sm font-medium">{t('choosePrevious',{year:sourceYear-1})}</p>{previous.length?previous.map(item=><Button key={item.id} type="button" variant="outline" onClick={()=>{setProposal(policyGridRows(kind,item[kind]));setPrevious(null);}}>{item.name} · {t('version',{version:item.revision})}</Button>):<p className="text-sm text-muted-foreground">{t('noPrevious')}</p>}<Button type="button" variant="ghost" onClick={()=>setPrevious(null)}>{t('cancel')}</Button></div>}
  {proposal&&<div className="space-y-3 rounded-md border border-primary/30 p-3"><h4 className="text-sm font-semibold">{t('preview')}</h4><GridPreview rows={proposal} columns={columns}/><p className="text-sm">{proposalIssues.length?t('proposalInvalid'):t('proposalHelp')}</p><Button type="button" onClick={()=>{changeRows(proposal);setProposal(null);}}>{t('apply')}</Button> <Button type="button" variant="outline" onClick={()=>setProposal(null)}>{t('cancel')}</Button></div>}
  <input type="text" className="sr-only" tabIndex={-1} aria-label={t(kind)} aria-describedby={issues.length?`${kind}-errors`:undefined} value="" readOnly ref={node=>node?.setCustomValidity(issues.length?t('invalidCell'):'')}/>
  <input type="hidden" name={kind} value={encodePolicyGrid(kind,rows)}/><input type="hidden" name={`policyGridData.${kind}`} value={JSON.stringify(rows)}/>
  <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{columns.map((name,i)=><th key={name} className="p-2 text-left">{i===0?t(kind==='branchFactors'?'segment':'grade'):kind==='ranges'?t(['minimum','midpoint','maximum'][i-1]):name}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>
   <th scope="row" className="p-2 text-left">{kind==='branchFactors'?<input aria-label={t('segment')} value={row[0]} aria-invalid={invalid(row[0],0)} aria-describedby={invalid(row[0],0)?`${kind}-errors`:undefined} ref={node=>node?.setCustomValidity(invalid(row[0],0)?t('invalidCell'):'')} onChange={event=>update(index,0,event.target.value)} className={`${inputCls} ${invalid(row[0],0)?'border-destructive bg-destructive/5':''}`} required maxLength={80}/>:row[0]}</th>
   {Array.from({length:policyGridWidth(kind)},(_,col)=>{const noRange=kind==='ranges'&&row[0]==='23',bad=invalid(row[0],col+1)||invalid(row[0],0);return <td key={col} className="p-2">{noRange?<span className="text-muted-foreground">{t('noRange')}</span>:<input type="number" min="0" max={kind==='ranges'?1_000_000_000:10} step={kind==='branchFactors'?'0.0001':'0.01'} required value={row[col+1]??''} aria-label={`${row[0]} ${columns[col+1]}`} aria-invalid={bad} aria-describedby={bad?`${kind}-errors`:undefined} ref={node=>node?.setCustomValidity(bad?t('invalidCell'):'')} onChange={event=>update(index,col+1,event.target.value)} className={`${inputCls} min-w-24 ${bad?'border-destructive bg-destructive/5':''}`}/>}</td>;})}
   {kind==='branchFactors'&&<td><Button type="button" variant="ghost" onClick={()=>changeRows(rows.filter((_,i)=>i!==index))}>{t('remove')}</Button></td>}
  </tr>)}</tbody></table></div>
  {kind==='branchFactors'&&<Button type="button" variant="outline" onClick={()=>changeRows([...rows,['', '0','','','','']])}>{t('addSegment')}</Button>}
  {issues.length>0&&<p id={`${kind}-errors`} role="alert" className="text-sm text-destructive">{t('invalidCell')}</p>}
 </section>;
}
function GridPreview({rows,columns}:{rows:string[][];columns:string[]}){return <div className="max-h-64 overflow-auto"><table className="w-full text-sm"><thead><tr>{columns.map(column=><th key={column} className="p-2 text-left">{column}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{row.map((cell,col)=><td key={col} className="p-2">{cell}</td>)}</tr>)}</tbody></table></div>;}
