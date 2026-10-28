'use client';
/** Explicit browser-only worksheet scope review. No action/provider/storage/implicit import. */
import {useId,useState} from 'react';
import {Button,inputCls} from './ui';
import {reviewPersonnelWorkbookRoles,type PersonnelWorkbookSource,type PersonnelSheetRole} from '@/lib/personnel-import-assistance-source';
export type PersonnelWorkbookReviewMessages=Readonly<{title:string;description:string;sheet:string;rows:string;role:string;employee:string;family:string;allocations:string;qualification:string;emergency:string;unassigned:string;excluded:string;acknowledge:string;apply:string;cancel:string;incomplete:string}>;
export function PersonnelImportWorkbookReview({workbook,revisionId,knownRoles,messages,onApply,onCancel,disabled=false}:{workbook:PersonnelWorkbookSource;revisionId:string;knownRoles:Readonly<Record<string,PersonnelSheetRole>>;messages:PersonnelWorkbookReviewMessages;onApply:(result:ReturnType<typeof reviewPersonnelWorkbookRoles>,expectedRevision:string)=>void;onCancel:()=>void;disabled?:boolean}){
 const id=useId(),[roles,setRoles]=useState<Record<string,PersonnelSheetRole>>(()=>Object.fromEntries(workbook.sheets.map(sheet=>[sheet.sheetName,knownRoles[sheet.sheetName]??'unassigned']))),[acknowledged,setAcknowledged]=useState(false);
 let reviewed:ReturnType<typeof reviewPersonnelWorkbookRoles>|null=null;try{reviewed=reviewPersonnelWorkbookRoles(workbook,roles,acknowledged);}catch{/* Explicit human choices still needed. */}
 const roleKeys:PersonnelSheetRole[]=['unassigned','employee','family','allocations','qualification','emergency','excluded'];
 return <section aria-labelledby={id} className="space-y-4 rounded-lg border border-border p-4"><div><h3 id={id} className="font-semibold">{messages.title}</h3><p className="mt-1 text-sm text-muted-foreground">{messages.description}</p></div>
  <div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{[messages.sheet,messages.rows,messages.role].map(label=><th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead><tbody>{workbook.sheets.map((sheet,index)=><tr key={sheet.sheetName} className="border-t border-border"><th scope="row" className="max-w-64 break-words p-2 font-medium">{sheet.sheetName}</th><td className="p-2">{sheet.source.rows.length}</td><td className="min-w-56 p-2"><label className="sr-only" htmlFor={`${id}-${index}`}>{messages.role}: {sheet.sheetName}</label><select id={`${id}-${index}`} className={inputCls} disabled={disabled} value={roles[sheet.sheetName]} onChange={e=>{setRoles(old=>({...old,[sheet.sheetName]:e.target.value as PersonnelSheetRole}));setAcknowledged(false);}}>{roleKeys.map(role=><option key={role} value={role}>{messages[role]}</option>)}</select></td></tr>)}</tbody></table></div>
  <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={disabled} onChange={e=>setAcknowledged(e.target.checked)}/><span>{messages.acknowledge}</span></label>
  {!reviewed&&<p role="status" className="text-sm text-muted-foreground">{messages.incomplete}</p>}
  <div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled||!reviewed} onClick={()=>{if(reviewed)onApply(reviewed,revisionId);}}>{messages.apply}</Button><Button type="button" variant="outline" disabled={disabled} onClick={onCancel}>{messages.cancel}</Button></div>
 </section>;
}
