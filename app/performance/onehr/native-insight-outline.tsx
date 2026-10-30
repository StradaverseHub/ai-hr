'use client';
import {useTranslations} from 'next-intl';
import {useState} from 'react';
import {NATIVE_OUTLINE_KINDS,nativeParagraphOutline,type NativeOutlineSection} from '@/lib/ai/native-insight-outline';
type Variant='paragraph'|'talent'|'idp';
function record(value:unknown,keys?:readonly string[]):Record<string,unknown>|null{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
 const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
 if(keys&&(names.length!==keys.length||names.some(name=>typeof name!=='string'||!keys.includes(name))))return null;
 const result=Object.create(null) as Record<string,unknown>;
 for(const name of names){const descriptor=typeof name==='string'?descriptors[name]:undefined;if(typeof name!=='string'||!descriptor?.enumerable||!('value'in descriptor))return null;result[name]=descriptor.value;}
 return result;
}
function list(value:unknown):unknown[]|null{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>24)return null;
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(descriptors).length!==value.length+1)return null;
 const result=[];for(let index=0;index<value.length;index++){const item=descriptors[String(index)];if(!item||!('value'in item))return null;result.push(item.value);}return result;
}
/** Client display validation adds no source authority. Match every quoted section against the actual
 * native fields already returned for this person; foreign/copied outlines cannot supply extra words. */
function readingOrder(data:unknown,variant:Variant,paragraphKind:NativeOutlineSection['kind']):readonly NativeOutlineSection[]|null{
 try{
  const native=record(data);if(!native)return null;
  const metadata=record(native.nativeOutline,['operation','order','sections']);if(metadata?.operation!=='native_outline_selection')return null;
  let expected:readonly NativeOutlineSection[];
  if(variant==='paragraph')expected=nativeParagraphOutline(native.paragraph as string,paragraphKind);
  else if(variant==='talent'){
   if(typeof native.insight!=='string'||typeof native.decision!=='string')return null;
   expected=[{index:0,kind:'summary',text:native.insight},{index:1,kind:'decision',text:native.decision}];
  }else{
   const discuss=list(native.discuss);if(typeof native.paragraph!=='string'||typeof native.verdict_why!=='string'||!discuss||discuss.some(text=>typeof text!=='string'))return null;
   expected=[{index:0,kind:'summary',text:native.paragraph},{index:1,kind:'decision',text:native.verdict_why},...discuss.map((text,index)=>({index:index+2,kind:'discussion' as const,text:text as string}))];
  }
  const order=list(metadata.order),sections=list(metadata.sections);
  if(!order||!sections||!expected.length||expected.length>24||sections.length!==expected.length||order.length!==sections.length)return null;
  const seen=new Set<number>(),byIndex=new Map<number,NativeOutlineSection>();let bytes=0;
  for(const value of sections){const section=record(value,['index','kind','text']);if(!section||typeof section.index!=='number'||!Number.isSafeInteger(section.index)||section.index<0||section.index>23||typeof section.kind!=='string'||!(NATIVE_OUTLINE_KINDS as readonly string[]).includes(section.kind)||typeof section.text!=='string'||!section.text.trim()||section.text.length>65536||byIndex.has(section.index))return null;
   const original=expected.find(item=>item.index===section.index);if(!original||original.kind!==section.kind||original.text!==section.text)return null;
   bytes+=section.text.length;if(bytes>262144)return null;byIndex.set(section.index,original);
  }
  for(const index of order){if(typeof index!=='number'||!Number.isSafeInteger(index)||!byIndex.has(index)||seen.has(index))return null;seen.add(index);}
  return order.map(index=>byIndex.get(index as number)!);
 }catch{return null;}
}
/** Supplementary presentation only. Primary native badges, decisions, figures and summaries remain
 * in their existing UI. React escapes all text; no model prose, HTML or links are interpreted. */
export function NativeInsightOutline({data,variant='paragraph',paragraphKind='summary'}:{data:unknown;variant?:Variant;paragraphKind?:NativeOutlineSection['kind']}){
 const t=useTranslations('onehr.protectedOutline'),[expanded,setExpanded]=useState(false),sections=readingOrder(data,variant,paragraphKind);if(!sections)return null;
 return <details className="rounded-md border border-border px-3" onToggle={event=>{event.stopPropagation();setExpanded(event.currentTarget.open);}}>
  <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t('title')}</summary>
  {expanded&&<div className="space-y-3 pb-3"><p className="text-xs text-muted-foreground">{t('help')}</p><ol aria-label={t('title')} className="list-decimal space-y-3 pl-5 text-sm leading-relaxed">{sections.map(section=><li key={section.index} className="whitespace-pre-wrap break-words">{section.text}</li>)}</ol></div>}
 </details>;
}
