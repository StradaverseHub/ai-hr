'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {btnPrimary} from './ui';

/** Review an explicit complete ID set before posting Copy; later arrivals cannot silently join it. */
export function RosterCopyTargets({populationQuery}:{populationQuery:string}){
 const t=useTranslations('roster'),common=useTranslations('common');
 const [ids,setIds]=useState<string[]|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(false);
 const prepare=async()=>{
  setLoading(true);setError(false);
  try{
   const query=new URLSearchParams(populationQuery);query.set('complete','1');
   const response=await fetch(`/roster/employee-choices?${query}`,{cache:'no-store'});
   if(!response.ok)throw new Error('Roster target preparation failed');
   const result=await response.json() as {ids:string[]};
   if(!Array.isArray(result.ids)||!result.ids.every(id=>typeof id==='string'))throw new Error('Invalid roster targets');
   setIds(result.ids);
  }catch{setError(true);}finally{setLoading(false);}
 };
 return <div className="space-y-2">
  {ids===null?<button type="button" className={btnPrimary} disabled={loading} onClick={()=>void prepare()}>{loading?common('loading'):t('copyButton')}</button>:<>
   <input type="hidden" name="selectionIds" value={JSON.stringify(ids)}/>
   <p role="status" className="text-xs text-muted-foreground">{t('copyTargetsReview',{n:ids.length})}</p>
   <button type="submit" className={btnPrimary} disabled={!ids.length}>{t('copyButton')}</button>
   <button type="button" className="ml-2 text-xs" onClick={()=>setIds(null)}>{common('cancel')}</button>
  </>}
  {error&&<p role="alert" className="text-xs">{t('pickerFailed')}</p>}
 </div>;
}
