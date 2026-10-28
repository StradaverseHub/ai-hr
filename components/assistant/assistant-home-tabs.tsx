'use client';
import * as React from 'react';

type Tab = 'work' | 'calendar';
/** Assistant home: "My work" and "Calendar" in one card. Each panel is an existing home card that reads its
 * own authorized facts; only the selected one is mounted, so the other reads nothing until it is opened.
 * Arrow keys move between tabs (WAI-ARIA tabs pattern). */
export function AssistantHomeTabs({labels,work,calendar}:{labels:{tabs:string;work:string;calendar:string};work:React.ReactNode;calendar:React.ReactNode}){
 const [tab,setTab]=React.useState<Tab>('work');
 const id=React.useId(),refs={work:React.useRef<HTMLButtonElement>(null),calendar:React.useRef<HTMLButtonElement>(null)};
 const order:Tab[]=['work','calendar'];
 const move=(event:React.KeyboardEvent)=>{
  if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft'&&event.key!=='Home'&&event.key!=='End')return;
  event.preventDefault();
  const index=order.indexOf(tab),next=event.key==='Home'?order[0]:event.key==='End'?order[order.length-1]:order[(index+(event.key==='ArrowRight'?1:order.length-1))%order.length];
  setTab(next);refs[next].current?.focus();
 };
 return <section aria-label={labels.tabs} className="rounded-xl border border-border">
  <div role="tablist" aria-label={labels.tabs} onKeyDown={move} className="flex gap-1 border-b border-border px-3">
   {order.map(key=><button key={key} ref={refs[key]} role="tab" type="button" id={`${id}-${key}-tab`} aria-controls={`${id}-${key}-panel`} aria-selected={tab===key} tabIndex={tab===key?0:-1}
    onClick={()=>setTab(key)}
    className={`-mb-px min-h-11 whitespace-nowrap border-b-2 px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none ${tab===key?'border-primary font-medium text-primary':'border-transparent text-muted-foreground hover:text-foreground'}`}>{key==='work'?labels.work:labels.calendar}</button>)}
  </div>
  <div role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}-tab`} className="p-3">{tab==='work'?work:calendar}</div>
 </section>;
}
