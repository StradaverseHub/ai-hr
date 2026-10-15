'use client';
import { createContext,useContext,useState,type Dispatch,type SetStateAction,type ReactNode } from 'react';
type Progress={answered:number;total:number;remark:boolean;submitted:boolean};
type Labels=[string,string,string];
const JourneyContext=createContext<{progress:Progress;setProgress:Dispatch<SetStateAction<Progress>>;labels:Labels}|null>(null);
export function JourneyProgressProvider({children,initial,labels}:{children:ReactNode;initial:Progress;labels:Labels}){
 const [progress,setProgress]=useState(initial);return <JourneyContext.Provider value={{progress,setProgress,labels}}>{children}</JourneyContext.Provider>;
}
function jump(index:number){
 const form=document.querySelector<HTMLFormElement>('form[data-assessment-draft]');if(!form)return;
 const target=index===0?form.querySelector<HTMLElement>('table')??form.querySelector<HTMLElement>('input[type="number"],select'):index===1?form.querySelector<HTMLElement>('[name="overallRemark"],[name="remark"]'):form.querySelector<HTMLElement>('[data-journey-confirm]');
 if(!target)return;const viewport=target.closest<HTMLElement>('[data-review-scroll]');if(viewport)viewport.scrollTo({top:viewport.scrollTop+target.getBoundingClientRect().top-viewport.getBoundingClientRect().top-12});else target.scrollIntoView({block:'center'});(target.matches('table')?target.querySelector<HTMLElement>('input[type="number"]'):target)?.focus({preventScroll:true});
}
function Steps({progress,labels}:{progress:Progress;labels:Labels}){
 const completed=[progress.total>0&&progress.answered===progress.total,progress.remark,progress.submitted],current=completed.findIndex(done=>!done);
 return <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label={labels.join(' · ')}>{labels.map((label,index)=><li key={label}><button type="button" onClick={()=>jump(index)} aria-current={current===index?'step':undefined} className={`flex min-h-11 items-center gap-1.5 rounded-md px-1.5 ${completed[index]?'text-primary':current===index?'font-semibold':'text-muted-foreground'}`}><span className="flex size-5 items-center justify-center rounded-full border border-current tabular-nums" aria-hidden="true">{completed[index]?'✓':index+1}</span><span>{label}{' '}{index===0&&progress.total>0&&<span className="ml-1.5 tabular-nums">{progress.answered}/{progress.total}</span>}</span></button></li>)}</ol>;
}
export function JourneySteps(){const context=useContext(JourneyContext);return context?<Steps progress={context.progress} labels={context.labels}/>:null;}
/** The source module bar and widget share one derived progress state. */
export function JourneyPanel({children,initial,labels}:{children:ReactNode;initial:Progress;labels:Labels}) {
 const shared=useContext(JourneyContext),[local,setLocal]=useState(initial),progress=shared?.progress??local,setProgress=shared?.setProgress??setLocal;
 return <div onChange={event=>{
  const target=event.target;if(!(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement))return;
  const form=target.form;if(!form?.hasAttribute('data-assessment-draft'))return;
  const data=new FormData(form),kind=String(data.get('draftKind')??'');
  const ids=data.getAll(kind==='results'||kind==='moderation'?'kpiId':'statementId').map(String);
  const answered=ids.filter(id=>String(data.get(kind==='results'||kind==='moderation'?`${id}.actual`:`answer.${id}`)??'').trim()!=='').length;
  setProgress(p=>({...p,answered,total:ids.length,remark:!!String(data.get(kind==='feedback'?'remark':'overallRemark')??'').trim()}));
 }}>
  {!shared&&<div className="border-b border-border px-5 py-2"><Steps progress={progress} labels={labels}/></div>}{children}
 </div>;
}
