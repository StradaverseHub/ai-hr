'use client';

import * as React from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {unstable_rethrow} from 'next/navigation';
import {Button,inputCls} from '@/components/ui';
import {localeNames,locales} from '@/i18n/config';
import {EMPLOYEE_HOME_CARDS,EMPLOYEE_HOME_CARD_DEFAULTS,type EmployeeHomePreferences,type EmployeeHomeCard} from '@/lib/employee-home';
import type {DashboardCardChoice} from '@/lib/dashboard-layout';
import {saveHomePreferencesAction,type HomePreferenceSaveState} from '@/app/(app)/me/home/actions';

export function HomePreferencesEditor({initial,cards}:{initial:EmployeeHomePreferences;cards:readonly (DashboardCardChoice&{name?:string})[]}){
 const t=useTranslations('employeeHome.preferences'),names=useTranslations('employeeHome.cardNames'),locale=useLocale();
 const [order,setOrder]=React.useState(initial.cardOrder),[hidden,setHidden]=React.useState(initial.hiddenCards);
 const [announcement,setAnnouncement]=React.useState('');
 const alert=React.useRef<HTMLParagraphElement|null>(null),inFlight=React.useRef(false);
 const moveButtons=React.useRef(new Map<string,HTMLButtonElement>());
 const moveFocus=React.useRef<string|null>(null);
 React.useLayoutEffect(()=>{if(moveFocus.current){moveButtons.current.get(moveFocus.current)?.focus();moveFocus.current=null;}},[order]);
 const submit=React.useCallback(async(state:HomePreferenceSaveState,data:FormData):Promise<HomePreferenceSaveState>=>{
  try{const result=await saveHomePreferencesAction(state,data);inFlight.current=false;return result;}
  catch(error){unstable_rethrow(error);inFlight.current=false;return {error:'failed'};}
 },[]);
 const [state,dispatch,pending]=React.useActionState<HomePreferenceSaveState,FormData>(submit,{error:null});
 React.useEffect(()=>{if(state.error)alert.current?.focus();},[state]);
 const cardByKey=new Map(cards.map(card=>[card.cardKey,card]));
 const label=(key:EmployeeHomeCard)=>{const name=cardByKey.get(key)?.name;return name&&name!==EMPLOYEE_HOME_CARD_DEFAULTS.find(card=>card.cardKey===key)?.name?name:names(key);};
 function move(key:EmployeeHomeCard,delta:number){
  const index=order.indexOf(key),next=index+delta;if(next<0||next>=order.length)return;
  const changed=[...order];[changed[index],changed[next]]=[changed[next],changed[index]];setOrder(changed);
  setAnnouncement(t('moved',{item:label(key),position:next+1}));
  // Keep the moved row's action focused after DOM reordering. At an edge use its other enabled action.
  moveFocus.current=`${key}:${next===0?1:next===order.length-1?-1:delta}`;
 }
 function send(data:FormData){if(inFlight.current)return;inFlight.current=true;React.startTransition(()=>dispatch(data));}
 return <form method="post" className="space-y-6" onSubmit={event=>{event.preventDefault();send(new FormData(event.currentTarget));}}>
  <input type="hidden" name="command" value="save"/>
  {order.map(key=><input key={key} type="hidden" name="cardOrder" value={key}/>)}
  {hidden.map(key=><input key={key} type="hidden" name="hiddenCard" value={key}/>)}
  {state.error&&<p ref={alert} role="alert" tabIndex={-1} className="rounded-md border border-destructive p-3 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(state.error)}</p>}
  <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
  <fieldset disabled={pending} className="space-y-6">
   <div className="grid gap-4 sm:grid-cols-2">
    <label className="min-w-0 space-y-2 text-sm"><span className="block font-medium">{t('language')}</span><select name="locale" defaultValue={locale} className={inputCls+' min-h-11 w-full'}>{locales.map(language=><option key={language} value={language}>{localeNames[language]}</option>)}</select></label>
    <label className="min-w-0 space-y-2 text-sm"><span className="block font-medium">{t('weekStart')}</span><select name="weekStartsOn" defaultValue={initial.weekStartsOn} className={inputCls+' min-h-11 w-full'}>{[1,2,3,4,5,6,0].map(day=><option key={day} value={day}>{new Intl.DateTimeFormat(locale,{weekday:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2024,0,7+day)))}</option>)}</select></label>
   </div>
   <div className="space-y-2 text-sm"><label htmlFor="home-display-zone" className="block font-medium">{t('timeZone')}</label><input id="home-display-zone" name="timeZone" type="text" maxLength={100} defaultValue={initial.timeZone??''} placeholder="Asia/Kuala_Lumpur" autoComplete="off" spellCheck={false} aria-describedby="home-zone-help" className={inputCls+' min-h-11 w-full'}/><p id="home-zone-help" className="max-w-prose text-muted-foreground">{t('timeZoneHelp')}</p></div>
   <section className="space-y-3" aria-labelledby="home-cards-heading"><h2 id="home-cards-heading" className="font-semibold">{t('cards')}</h2><p className="max-w-prose text-sm text-muted-foreground">{t('cardsHelp')}</p>
    <ol className="divide-y rounded-lg border">{order.map((key,index)=>{
     const card=cardByKey.get(key),required=Boolean(card?.mandatory),locked=!card||required||!card.employeeSelectable;
     return <li key={key} className="flex flex-wrap items-center justify-between gap-2 p-3" data-home-preference-card={key}>
      <div className="min-w-0"><label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={!hidden.includes(key)} disabled={locked} onChange={event=>{const checked=event.target.checked;setHidden(previous=>checked?previous.filter(item=>item!==key):[...previous,key]);}}/><span className="break-words">{label(key)}</span></label>
       {locked&&<p className="pl-6 text-sm text-muted-foreground">{!card?t('unavailable'):required?t('required'):t('managed')}</p>}
      </div>
      <span className="flex gap-2">{([-1,1] as const).map(delta=><Button key={delta} type="button" variant="outline" className="min-h-11 min-w-11" disabled={delta<0?index===0:index===EMPLOYEE_HOME_CARDS.length-1} aria-label={t(delta<0?'moveUp':'moveDown',{item:label(key)})} ref={element=>{const id=`${key}:${delta}`;if(element)moveButtons.current.set(id,element);else moveButtons.current.delete(id);}} onClick={()=>move(key,delta)}>{delta<0?'↑':'↓'}</Button>)}</span>
     </li>;
    })}</ol>
   </section>
   <div className="flex flex-wrap gap-3"><Button type="submit" className="min-h-11">{pending?t('saving'):t('save')}</Button><Button type="button" variant="outline" className="min-h-11" onClick={()=>{const data=new FormData();data.set('command','reset');send(data);}}>{t('reset')}</Button></div>
  </fieldset>
 </form>;
}
