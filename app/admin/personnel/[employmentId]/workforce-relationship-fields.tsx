'use client';

import {useState,type ReactNode} from 'react';
import {dependentFieldApplies} from '@/lib/dependent-vocabulary';
import {personnelCarry} from '@/lib/personnel-form-contract';

export type WorkforceFieldSlot={name:string;fieldId:string;emptyValue:string;content:ReactNode};

/** Only relationship state crosses this boundary. Labels, options and controls stay server-owned.
 * Disabled hidden fields never submit stale values; finite blank placeholders retain the action's
 * exact field contract. The canonical normalizer still decides what can be stored. */
export function WorkforceRelationshipFields({initialRelationship,fields}:{initialRelationship:string;fields:WorkforceFieldSlot[]}){
 const [relationship,setRelationship]=useState(initialRelationship);
 return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onChange={event=>{
  if(event.target instanceof HTMLSelectElement&&event.target.name==='relationship')setRelationship(event.target.value);
 }}>
  {fields.map(field=>{
   const applicable=field.name==='relationship'||Boolean(relationship)&&dependentFieldApplies(relationship,field.name);
   return <div key={field.name} hidden={!applicable} className="min-w-0">
    {!applicable&&<input {...personnelCarry(field.fieldId)} value={field.emptyValue}/>}
    <fieldset disabled={!applicable} className="min-w-0">{field.content}</fieldset>
   </div>;
  })}
 </div>;
}
