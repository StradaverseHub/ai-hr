'use client';
import {useEffect,useId,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {BusinessPartnerDimension,BusinessPartnerRule,BusinessPartnerWorkspace} from '@/packs/automation/service';
import type {NamedOption} from '../recipients';
import {MultiSelect} from '../multi-select';
import {PeopleSearch} from '../people-search';
import {saveBusinessPartnersAction,searchBusinessPartnerPeopleAction,searchBusinessPartnerScopeOptionsAction} from '../actions';

type Dimension=BusinessPartnerDimension;
const DIMENSIONS:readonly Dimension[]=['businessGroup','company','department'];
type DraftRow={key:string;assignment:BusinessPartnerRule};
const draftRows=(rules:BusinessPartnerRule[]):DraftRow[]=>rules.map((assignment,index)=>({key:'saved-'+index,assignment:structuredClone(assignment)}));
const include=(known:readonly NamedOption[],item:NamedOption)=>known.some(option=>option.id===item.id)?[...known]:[...known,item];

/** Business responsibility is separate from a named recipient/signing routing and from an Access grant. */
export function BusinessPartnerRules({initial}:{initial:BusinessPartnerWorkspace}){
 const t=useTranslations('automation.businessPartners'),router=useRouter(),reasonId=useId();
 const [saved,setSaved]=useState(initial),[rows,setRows]=useState(()=>draftRows(initial.rules));
 const [people,setPeople]=useState(initial.people),[scopeLabels,setScopeLabels]=useState(initial.scopeLabels);
 const [reason,setReason]=useState(''),[dirty,setDirty]=useState(false),[notice,setNotice]=useState<{error:boolean;text:string;problems?:string[]}|null>(null),[busy,start]=useTransition();
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const sourceChanged=initial.revision>saved.revision;
 const valid=rows.length<=500&&rows.every(row=>!!row.assignment.userId&&people.some(person=>person.id===row.assignment.userId));
 const change=(update:(current:DraftRow[])=>DraftRow[])=>{if(busy)return;setRows(update);setDirty(true);setNotice(null);};
 const edit=(key:string,update:(rule:BusinessPartnerRule)=>void)=>change(current=>current.map(row=>{if(row.key!==key)return row;const assignment=structuredClone(row.assignment);update(assignment);return {...row,assignment};}));
 const restore=(workspace:BusinessPartnerWorkspace)=>{setRows(draftRows(workspace.rules));setSaved(workspace);setPeople(workspace.people);setScopeLabels(workspace.scopeLabels);setReason('');setDirty(false);setNotice(null);};
 const save=()=>{if(busy||sourceChanged||!dirty||!valid||reason.trim().length<20)return;
  start(async()=>{try{
   const result=await saveBusinessPartnersAction({expectedRevision:saved.revision,rules:rows.map(row=>row.assignment),reason:reason.trim()});
   if(!alive.current)return;
   if(!result.ok){setNotice({error:true,text:result.detail??t('failed'),problems:result.problems});return;}
   restore(result.result);setNotice({error:false,text:t('saved')});router.refresh();
  }catch{if(alive.current)setNotice({error:true,text:t('failed')});}});
 };
 return <section className="v9-stack" aria-labelledby="business-partner-responsibilities">
  <div className="automation-row automation-between"><div><h2 id="business-partner-responsibilities">{t('title')}</h2><p className="v9-muted">{t('intro')}</p></div><button type="button" className="v9-button" disabled={busy||rows.length>=500||sourceChanged} onClick={()=>change(current=>[...current,{key:crypto.randomUUID(),assignment:{userId:'',rules:{}}}])}>{t('add')}</button></div>
  <p className="v9-muted">{t('separate')}</p>
  {!rows.length&&<p className="v9-notice">{t('empty')}</p>}
  {sourceChanged&&<div className="v9-notice" role="status"><p>{t('newer')}</p><button type="button" className="v9-button" disabled={busy} onClick={()=>restore(initial)}>{t('reload')}</button></div>}
  <div className="v9-stack">{rows.map((row,index)=>{const person=people.find(option=>option.id===row.assignment.userId);return <article className="pcg-card v9-stack" key={row.key} aria-label={t('assignment',{number:index+1})}>
   <div className="automation-row automation-between"><h3>{person?.name??t(row.assignment.userId?'unavailableAccount':'choosePerson')}</h3><button type="button" className="v9-button" disabled={busy||sourceChanged} aria-label={t('removeLabel',{number:index+1})} onClick={()=>change(current=>current.filter(item=>item.key!==row.key))}>{t('remove')}</button></div>
   {row.assignment.userId&&!person&&<p className="v9-notice">{t('unavailableHelp')}</p>}
   <details open={!row.assignment.userId}><summary>{t('findPerson')}</summary><PeopleSearch searchPeople={searchBusinessPartnerPeopleAction} known={person?[person]:[]} disabled={busy||sourceChanged} onAdd={selected=>{if(busy||sourceChanged)return;setPeople(current=>include(current,selected));edit(row.key,rule=>{rule.userId=selected.id;});}}/></details>
   <div className="v9-fields">{DIMENSIONS.map(dimension=><ScopeChoices key={dimension} dimension={dimension} row={index+1} value={row.assignment.rules[dimension]??[]} options={scopeLabels[dimension]} disabled={busy||sourceChanged}
    onChange={value=>edit(row.key,rule=>{if(value.length)rule.rules[dimension]=value;else delete rule.rules[dimension];})}
    onOption={option=>setScopeLabels(current=>({...current,[dimension]:include(current[dimension],option)}))}/>)}</div>
  </article>;})}</div>
  <p className="v9-muted">{t('matching')}</p>
  <label className="v9-field" htmlFor={reasonId}><span>{t('reason')}</span><textarea id={reasonId} className="v9-input" rows={3} maxLength={5000} value={reason} disabled={busy||sourceChanged} aria-describedby={reasonId+'-help'} onChange={event=>{setReason(event.target.value);setNotice(null);}}/></label>
  <p id={reasonId+'-help'} className="v9-muted">{t('reasonHelp')}</p>
  {dirty&&<p className="v9-muted" role="status">{t('unsaved')}</p>}
  {notice&&<div className={'v9-notice'+(notice.error?' v9-error':'')} role={notice.error?'alert':'status'}>{notice.text}{notice.problems?.length?<ul>{notice.problems.map((problem,index)=><li key={index}>{problem}</li>)}</ul>:null}</div>}
  <div className="automation-row"><button type="button" className="v9-button v9-button-primary" disabled={busy||sourceChanged||!dirty||!valid||reason.trim().length<20} onClick={save}>{t(busy?'saving':'save')}</button>{dirty&&<button type="button" className="v9-button" disabled={busy} onClick={()=>restore(sourceChanged?initial:saved)}>{t('discard')}</button>}</div>
 </section>;
}

/** Searches one authorized master-data dimension; selected saved options stay visible without loading all masters. */
function ScopeChoices({dimension,row,value,options,disabled,onChange,onOption}:{dimension:Dimension;row:number;value:string[];options:NamedOption[];disabled:boolean;onChange:(value:string[])=>void;onOption:(option:NamedOption)=>void}){
 const t=useTranslations('automation.businessPartners'),[query,setQuery]=useState(''),[found,setFound]=useState<NamedOption[]|null>(null),[error,setError]=useState(''),[busy,start]=useTransition();
 const request=useRef(0);useEffect(()=>()=>{request.current++;},[]);
 const all=[...options,...value.filter(id=>!options.some(option=>option.id===id)).map(id=>({id,name:t('unavailableScope')}))];
 const search=()=>{if(disabled||busy||query.trim().length<2)return;const current=++request.current;setError('');start(async()=>{try{
  const result=await searchBusinessPartnerScopeOptionsAction(dimension,query.trim());if(current!==request.current)return;
  if(!result.ok){setError(result.detail??t('searchFailed'));setFound(null);return;}setFound(result.result);
 }catch{if(current===request.current){setError(t('searchFailed'));setFound(null);}}});};
 return <div className="v9-field v9-stack"><span>{t(dimension)}</span><MultiSelect label={t('scopeLabel',{number:row,scope:t(dimension)})} value={value} options={all.map(option=>({value:option.id,label:option.name}))} emptyLabel={t('any')} disabled={disabled} onChange={onChange}/>
  <details><summary>{t('findScope',{scope:t(dimension)})}</summary><div className="automation-people-search v9-stack"><div className="automation-row"><input className="v9-input" maxLength={100} value={query} aria-label={t('searchScope',{number:row,scope:t(dimension)})} disabled={disabled} onChange={event=>{request.current++;setQuery(event.target.value);setFound(null);setError('');}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();search();}}}/><button type="button" className="v9-button" disabled={disabled||busy||query.trim().length<2} onClick={search}>{t(busy?'searching':'find')}</button></div>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}{found&&(found.length?<ul className="automation-plain-list">{found.map(option=><li key={option.id} className="automation-row automation-between"><span>{option.name}</span>{value.includes(option.id)?<span className="v9-muted">{t('selected')}</span>:<button type="button" className="v9-button" disabled={disabled} onClick={()=>{onOption(option);onChange([...value,option.id]);}}>{t('selectScope',{name:option.name})}</button>}</li>)}</ul>:<p className="v9-muted">{t('noMatches')}</p>)}
  </div></details>
 </div>;
}
