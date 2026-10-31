'use client';

import * as React from 'react';
import {useTranslations} from 'next-intl';
import {unstable_rethrow} from 'next/navigation';
import {Button} from '@/components/ui';
import type {HomePersonPrivacy} from '@/lib/employee-home-person-privacy';
import {saveHomePersonPrivacyAction,type HomePersonPrivacySaveState} from '@/app/(app)/me/home/privacy-actions';

export function HomePersonPrivacyEditor({initial,saved=false}:{initial:HomePersonPrivacy;saved?:boolean}){
 const t=useTranslations('employeeHome.personPrivacy');
 const [hideBirthday,setHideBirthday]=React.useState(initial.hideBirthday),[hideAnniversary,setHideAnniversary]=React.useState(initial.hideAnniversary);
 const [edited,setEdited]=React.useState(false);
 const alert=React.useRef<HTMLParagraphElement|null>(null),inFlight=React.useRef(false);
 const submit=React.useCallback(async(state:HomePersonPrivacySaveState,data:FormData):Promise<HomePersonPrivacySaveState>=>{
  try{const result=await saveHomePersonPrivacyAction(state,data);if(result.alreadySaved)setEdited(false);inFlight.current=false;return result;}
  catch(error){unstable_rethrow(error);inFlight.current=false;return {error:'failed'};}
 },[]);
 const [state,dispatch,pending]=React.useActionState<HomePersonPrivacySaveState,FormData>(submit,{error:null});
 React.useEffect(()=>{if(state.error)alert.current?.focus();},[state]);
 return <form method="post" className="space-y-4" onSubmit={event=>{
  event.preventDefault();if(inFlight.current)return;inFlight.current=true;
  const data=new FormData(event.currentTarget);React.startTransition(()=>dispatch(data));
 }}>
  <input type="hidden" name="expectedOrdinal" value={initial.ordinal}/>
  {(saved||state.alreadySaved)&&!edited&&!pending&&!state.error&&<p role="status" className="text-sm">{t(state.alreadySaved?'alreadySaved':'saved')}</p>}
  {state.error&&<p ref={alert} role="alert" tabIndex={-1} className="rounded-md border border-destructive p-3 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(state.error)}</p>}
  {state.error==='changed'&&<a href="/me/home" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">{t('reload')}</a>}
  <fieldset disabled={pending} className="space-y-4" aria-describedby="home-person-privacy-help">
   <legend className="sr-only">{t('title')}</legend>
   <p id="home-person-privacy-help" className="max-w-prose text-sm text-muted-foreground">{t('policyHelp')}</p>
   <div className="space-y-2">
    <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name="hideBirthday" value="1" checked={hideBirthday} onChange={event=>{setHideBirthday(event.target.checked);setEdited(true);}}/><span>{t('hideBirthday')}</span></label>
    <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name="hideAnniversary" value="1" checked={hideAnniversary} onChange={event=>{setHideAnniversary(event.target.checked);setEdited(true);}}/><span>{t('hideAnniversary')}</span></label>
   </div>
   <Button type="submit" className="min-h-11 h-auto whitespace-normal py-2 text-start">{pending?t('saving'):t('save')}</Button>
  </fieldset>
 </form>;
}
