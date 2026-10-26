/** Client-local header review. No provider/action/storage/commit import; sample values never leave
 * this component's browser memory. The parent applies a new revision then requires fresh validation. */
'use client';
import {useId,useState} from 'react';
import {Button,inputCls} from './ui';
import {personnelHeaderSuggestions,type PersonnelImportSource} from '@/lib/personnel-import-assistance-source';
import type {PersonnelImportHeaderOptions} from '@/lib/personnel-import-contract';
export type PersonnelImportHeaderReviewMessages=Readonly<{title:string;localOnly:string;sheet:string;column:string;sourceHeading:string;sampleValues:string;destination:string;chooseField:string;unresolved:string;ambiguous:string;duplicate:string;applyMapping:string;cancel:string;reviewHeadings:string;invalidSource:string;acceptedRevision:string;sourceChanged:string;unknownSheet:string}>;
export function PersonnelImportHeaderReview({source,options,choices,messages,onApply,onCancel,disabled=false}:{source:PersonnelImportSource;options:PersonnelImportHeaderOptions;choices:readonly {key:string;label:string}[];messages:PersonnelImportHeaderReviewMessages;onApply:(destinations:readonly string[],revisionId:string)=>void;onCancel:()=>void;disabled?:boolean}){
 const id=useId(),suggestions=personnelHeaderSuggestions(source,options);
 const [selected,setSelected]=useState(()=>source.acceptedDestinations?[...source.acceptedDestinations]:suggestions.map(row=>row.matches.length===1?row.matches[0]:''));
 const duplicates=new Set(selected.filter((key,index)=>key&&selected.indexOf(key)!==index));
 const ready=selected.length===source.matrix[0].length&&selected.every(key=>choices.some(choice=>choice.key===key))&&duplicates.size===0;
 return <section aria-labelledby={id} className="space-y-4 rounded-lg border border-border bg-background p-4">
  <div><h3 id={id} className="text-sm font-semibold">{messages.title}</h3><p className="mt-1 text-sm text-muted-foreground">{messages.localOnly}</p>
   <p className="mt-2 text-xs text-muted-foreground">{messages.sheet}: {source.sheetName??messages.unknownSheet}</p></div>
  <div className="max-h-[30rem] overflow-auto rounded-md border border-border"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-muted"><tr>{[messages.column,messages.sourceHeading,messages.sampleValues,messages.destination].map(label=><th key={label} scope="col" className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>
   {suggestions.map((row,index)=>{const issue=duplicates.has(selected[index])?messages.duplicate:!selected[index]?row.matches.length>1?messages.ambiguous:messages.unresolved:null;
    return <tr key={index} className="border-t border-border align-top"><td className="p-3">{source.provenance?.rows[0]?.cells[index]?.column??index+1}</td><th scope="row" className="max-w-64 break-words p-3 font-medium">{row.raw}</th>
     <td className="max-w-64 p-3"><ul className="space-y-1">{source.matrix.slice(1,4).map((values,r)=><li key={r} className="break-words whitespace-pre-wrap">{source.provenance?.rows.find(row=>row.row===source.rowNumbers[r+1])?.cells[index]?.display??values[index]??'—'}</li>)}</ul></td>
     <td className="min-w-52 p-3"><label htmlFor={`${id}-${index}`} className="sr-only">{messages.destination}: {row.raw}</label><select id={`${id}-${index}`} className={inputCls} value={selected[index]??''} disabled={disabled} aria-invalid={!!issue} aria-describedby={issue?`${id}-issue-${index}`:undefined} onChange={e=>setSelected(old=>old.map((value,i)=>i===index?e.target.value:value))}>
      <option value="">{messages.chooseField}</option>{choices.map(choice=><option key={choice.key} value={choice.key}>{choice.label}</option>)}</select>{issue&&<p id={`${id}-issue-${index}`} className="mt-1 text-destructive">{issue}</p>}</td></tr>;
   })}
  </tbody></table></div>
  <div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled||!ready} onClick={()=>onApply([...selected],source.revisionId)}>{messages.applyMapping}</Button><Button type="button" variant="outline" disabled={disabled} onClick={onCancel}>{messages.cancel}</Button></div>
 </section>;
}
