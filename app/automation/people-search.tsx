'use client';
import {useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {searchPeopleAction} from './actions';
import type {NamedOption} from './recipients';

/** Finds active people the viewer may see (server search, at most 20) and makes them choosable as named people. */
export function PeopleSearch({known,onAdd,disabled=false,available}:{known:readonly NamedOption[];onAdd:(person:NamedOption)=>void;disabled?:boolean;available?:readonly NamedOption[]}){
 const t=useTranslations('automation'),[query,setQuery]=useState(''),[found,setFound]=useState<NamedOption[]|null>(null),[error,setError]=useState(''),[busy,start]=useTransition();
 const search=()=>{setError('');if(available){setFound(available.filter(person=>person.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0,20));return;}start(async()=>{const result=await searchPeopleAction(query);if(!result.ok){setError(result.detail??t('errors.unavailable'));setFound(null);return;}setFound(result.result);});};
 return <div className="automation-people-search v9-stack">
  <div className="automation-row">
   <input aria-label={t('people.search')} placeholder={t('people.placeholder')} value={query} disabled={disabled} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();search();}}}/>
   <button type="button" className="v9-button" disabled={disabled||busy||query.trim().length<2} onClick={search}>{t('people.find')}</button>
  </div>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
  {found&&(found.length?<ul className="automation-plain-list">{found.map(person=><li key={person.id}><span>{person.name}</span>{known.some(k=>k.id===person.id)?<span className="v9-muted">{t('people.added')}</span>:<button type="button" className="v9-button" onClick={()=>onAdd(person)}>{t('people.add',{name:person.name})}</button>}</li>)}</ul>:<p className="v9-muted">{t('people.none')}</p>)}
 </div>;
}
