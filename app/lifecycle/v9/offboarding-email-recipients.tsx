'use client';
import {useState} from 'react';
import {MultiSelect} from '@/app/automation/multi-select';
import {PeopleSearch} from '@/app/automation/people-search';
import {recipientFromKey,recipientKey,recipientOptions,recipientsFromKeys,type RecipientChoices} from '@/app/automation/recipients';
import {OFFBOARDING_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/offboarding';
import type {EmailTemplate} from '@/lib/lifecycle-v9-model';
/** Offboarding's shared recipients supplement the existing V9 CC without changing its stored role semantics. */
export function OffboardingEmailRecipients({email,choices,disabled,change}:{email:EmailTemplate;choices:RecipientChoices;disabled:boolean;change:(update:(next:EmailTemplate)=>void)=>void}){
 const [people,setPeople]=useState([...choices.people]);
 const availablePeople=[...choices.people,...people].filter((person,index,all)=>all.findIndex(candidate=>candidate.id===person.id)===index);
 const options=recipientOptions(OFFBOARDING_AUTOMATION_CATALOGUE,{...choices,people:availablePeople},{routing:name=>'Routing: '+name,group:name=>'Group: '+name}).filter(option=>option.value!=='pending');
 return <section className="v9-stack" aria-label="Offboarding recipients"><MultiSelect label="Additional default CC from shared configuration" options={options} value={(email.routingCc??[]).map(recipientKey)} disabled={disabled} onChange={keys=>change(next=>{next.routingCc=recipientsFromKeys(keys);})}/>
 <details><summary>Find named people</summary><PeopleSearch known={availablePeople} disabled={disabled} onAdd={person=>setPeople(current=>current.some(p=>p.id===person.id)?current:[...current,person])}/></details>
 {email.slots.map(slot=><label className="v9-field" key={slot.id}><span>Who uploads {slot.label||'this file'}</span><select disabled={disabled} value={slot.by?recipientKey(slot.by):''} onChange={event=>change(next=>{const target=next.slots.find(item=>item.id===slot.id)!;const by=recipientFromKey(event.target.value);if(by)target.by=by;else delete target.by;})}><option value="">Configured GBS People Ops group</option>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
 </section>;
}
