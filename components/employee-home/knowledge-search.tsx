'use client';

import * as React from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui';
import type {Locale} from '@/i18n/config';
import {deliverHomeCard} from '@/lib/employee-home-delivery';
import {HOME_SEARCH_DEBOUNCE_MS,HOME_SEARCH_QUERY_MAX,HOME_SEARCH_RESULT_LIMIT,homeKnowledgeHref,homeSearchWords} from '@/lib/employee-home-search';

type Item={id:string;title:string};
type State={state:'idle'|'loading'}|{state:'ready';items:Item[]}|{state:'failed';reason:'timeout'|'unavailable'|'invalid'};
export type HomeKnowledgeSearchLabels={label:string;hint:string;submit:string;loading:string;results:string;noMatch:string;failed:string;timeout:string;invalid:string};

/** Library facet only: forms/pages join through their own permission-filtered owner. Debounced
 * lexical reads never call a model, invent suggestions or store a query in personal preferences.
 */
export function HomeKnowledgeSearch({locale,labels}:{locale:Locale;labels:HomeKnowledgeSearchLabels}){
  return <KnowledgeSearch key={locale} locale={locale} labels={labels}/>;
}
function KnowledgeSearch({locale,labels}:{locale:Locale;labels:HomeKnowledgeSearchLabels}){
  const inputId=React.useId(),hintId=React.useId(),resultsId=React.useId();
  const [query,setQuery]=React.useState(''),[view,setView]=React.useState<State>({state:'idle'});
  const [composing,setComposing]=React.useState(false);
  const current=React.useRef<AbortController|null>(null);
  const pending=React.useRef<ReturnType<typeof setTimeout>|null>(null);
  const cancelDelay=React.useCallback(()=>{
    if(pending.current!==null){clearTimeout(pending.current);pending.current=null;}
  },[]);
  React.useEffect(()=>()=>{cancelDelay();current.current?.abort();},[cancelDelay]);
  const search=React.useCallback(async()=>{
    cancelDelay();current.current?.abort();current.current=null;
    try{if(!homeSearchWords(query).length){setView(query.trim()?{state:'failed',reason:'invalid'}:{state:'idle'});return;}}
    catch{setView({state:'failed',reason:'invalid'});return;}
    const controller=new AbortController();current.current=controller;setView({state:'loading'});
    const result=await deliverHomeCard(async signal=>{
      const params=new URLSearchParams({q:query,locale});
      const response=await fetch(`/api/home/knowledge?${params}`,{signal,cache:'no-store',credentials:'same-origin'});
      if(!response.ok)throw new Error('Home search unavailable');
      const body:unknown=await response.json();
      if(!body||typeof body!=='object'||!('version' in body)||body.version!==1||!('items' in body)||!Array.isArray(body.items)||body.items.length>HOME_SEARCH_RESULT_LIMIT)
        throw new Error('Home search unavailable');
      const items=body.items.map((item:unknown):Item=>{
        if(!item||typeof item!=='object'||!('id' in item)||typeof item.id!=='string'||!item.id||!('title' in item)||typeof item.title!=='string'||!item.title.trim())
          throw new Error('Home search unavailable');
        return {id:item.id,title:item.title}; // Ignore upstream bodies, authors, arbitrary hrefs and extra data.
      });
      if(new Set(items.map(item=>item.id)).size!==items.length)throw new Error('Home search unavailable');
      return items;
    },{signal:controller.signal,timeoutMs:2400}); // Leave room for the typing delay within the read budget.
    if(current.current!==controller||result.state==='cancelled')return;
    current.current=null;
    setView(result.state==='ready'?{state:'ready',items:result.value}:{state:'failed',reason:result.reason});
  },[query,locale,cancelDelay]);
  React.useEffect(()=>{
    if(!query.trim()||composing)return;
    pending.current=setTimeout(()=>{pending.current=null;void search();},HOME_SEARCH_DEBOUNCE_MS);
    return cancelDelay;
  },[query,composing,search,cancelDelay]);
  return <div className="space-y-3">
    <form role="search" aria-label={labels.label} onSubmit={event=>{event.preventDefault();if(!composing)void search();}} className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium">{labels.label}</label>
      <div className="flex flex-wrap gap-2">
        <input id={inputId} type="search" value={query} maxLength={HOME_SEARCH_QUERY_MAX} aria-describedby={hintId}
          aria-controls={resultsId} autoComplete="off" className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onCompositionStart={()=>{cancelDelay();current.current?.abort();current.current=null;setComposing(true);setView({state:'idle'});}}
          onCompositionEnd={()=>setComposing(false)}
          onChange={event=>{cancelDelay();current.current?.abort();current.current=null;setQuery(event.target.value);setView({state:'idle'});}}/>
        <Button type="submit" variant="outline" className="min-h-11" disabled={view.state==='loading'||!query.trim()}>{labels.submit}</Button>
      </div>
      <p id={hintId} className="max-w-prose text-sm leading-relaxed text-muted-foreground">{labels.hint}</p>
    </form>
    <div id={resultsId} aria-busy={view.state==='loading'}>
      {view.state==='loading'&&<p role="status" className="text-sm">{labels.loading}</p>}
      {view.state==='failed'&&<p role="alert" className="text-sm leading-relaxed">{view.reason==='timeout'?labels.timeout:view.reason==='invalid'?labels.invalid:labels.failed}</p>}
      {view.state==='ready'&&(view.items.length===0?<p role="status" className="text-sm leading-relaxed">{labels.noMatch}</p>:
        <section aria-label={labels.results} className="space-y-2">
          <h3 className="text-sm font-semibold">{labels.results}</h3>
          <ul className="divide-y divide-border">{view.items.map(item=><li key={item.id}>
            <Link href={homeKnowledgeHref(item.id)} className="flex min-h-11 items-center rounded-md py-2 text-sm leading-relaxed underline underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.title}</Link>
          </li>)}</ul>
        </section>)}
    </div>
  </div>;
}
