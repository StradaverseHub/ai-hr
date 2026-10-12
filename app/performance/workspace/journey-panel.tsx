'use client';

import { useState, type ReactNode } from 'react';

type Progress={answered:number;total:number;remark:boolean;submitted:boolean};
/** The source journey keeps the active widget inside the conversation, above its composer. */
export function JourneyPanel({children,initial,labels}:{children:ReactNode;initial:Progress;labels:[string,string,string]}) {
 const [progress,setProgress]=useState(initial);
 const completed=[progress.total>0&&progress.answered===progress.total,progress.remark,progress.submitted];
 const current=completed.findIndex(done=>!done);
 return <div onChange={event=>{
  const target=event.target;if(!(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement))return;
  const form=target.form;if(!form?.hasAttribute('data-assessment-draft'))return;
  const data=new FormData(form),kind=String(data.get('draftKind')??'');
  const ids=data.getAll(kind==='results'||kind==='moderation'?'kpiId':'statementId').map(String);
  const answered=ids.filter(id=>String(data.get(kind==='results'||kind==='moderation'?`${id}.actual`:`answer.${id}`)??'').trim()!=='').length;
  setProgress(p=>({...p,answered,total:ids.length,remark:!!String(data.get(kind==='feedback'?'remark':'overallRemark')??'').trim()}));
 }}>
  <ol className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-muted/30 px-5 py-3 text-xs" aria-label={labels.join(' · ')}>{labels.map((label,index)=><li key={label} aria-current={current===index?'step':undefined} className={`flex items-center gap-2 ${completed[index]?'text-primary':current===index?'font-semibold':'text-muted-foreground'}`}><span className="flex size-6 items-center justify-center rounded-full border border-current tabular-nums" aria-hidden="true">{completed[index]?'✓':index+1}</span><span>{label}{index===0&&progress.total>0&&<span className="ml-2 tabular-nums">{progress.answered}/{progress.total}</span>}</span></li>)}</ol>
  {children}
 </div>;
}
