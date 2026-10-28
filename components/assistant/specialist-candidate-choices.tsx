"use client";
import {useState} from 'react';
import {inputCls} from '../ui';
type ModuleChoice=Readonly<{value:string;module:string;label:string}>;
type EvidenceChoice=Readonly<{value:string;module:string;label:string}>;
/** Metadata only. Module edits retire the old evidence choice; the server still reopens its exact
 * canonical source and rejects posted/foreign/erased choices before publishing any candidate. */
export function SpecialistCandidateChoices({modules,evidence,messages}:{modules:readonly ModuleChoice[];evidence:readonly EvidenceChoice[];messages:Readonly<{module:string;nativeTitle:string;nativeIntro:string;nativeNone:string}>}){
 const [selection,setSelection]=useState(modules[0]?.value??''),[nativeId,setNativeId]=useState('');
 const module=modules.find(choice=>choice.value===selection)?.module,choices=evidence.filter(choice=>choice.module===module);
 return <>
  <label className="block text-sm">{messages.module}<select name="moduleVersion" required value={selection} onChange={event=>{setSelection(event.target.value);setNativeId('');}} className={`${inputCls} mt-1 min-h-11 w-full`}>{modules.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
  {choices.length>0&&<label className="block text-sm">{messages.nativeTitle}<span className="mt-1 block text-xs text-muted-foreground">{messages.nativeIntro}</span><select name="nativeSignalId" value={nativeId} onChange={event=>setNativeId(event.target.value)} className={`${inputCls} mt-1 min-h-11 w-full`}><option value="">{messages.nativeNone}</option>{choices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>}
 </>;
}
