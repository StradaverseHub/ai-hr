'use client';

import * as React from 'react';
import {useLocale} from 'next-intl';
import {
 DEFAULT_HOME_SHARING_CARDS,HOME_SHARING_MAX_FRAME_BYTES,HOME_SHARING_STREAM,isHomeSharingCard,type HomeSharingCard,
} from '@/lib/employee-home-sharing-cohort';

type Subscribe=(card:HomeSharingCard,signal:AbortSignal,fallback:()=>Promise<unknown>)=>Promise<unknown>;
type Subscriber={
 signal:AbortSignal;
 fallback:()=>Promise<unknown>;
 complete:(value:unknown)=>void;
 fail:()=>void;
};
const SharingCohort=React.createContext<Subscribe|null>(null);
const unavailable=()=>new Error('Initial Home sharing unavailable');

async function streamSharing(
 employmentId:string,
 subscribers:Map<HomeSharingCard,Subscriber>,
 controller:AbortController,
 month?:string,
){
 const requested=[...subscribers.keys()];
 const seen=new Set<HomeSharingCard>();
 function deliver(line:string){
  const frame:unknown=JSON.parse(line);
  if(!frame||typeof frame!=='object'||!('card' in frame)||!('version' in frame)||!('status' in frame)||
    frame.version!==1||!isHomeSharingCard(frame.card)||!requested.includes(frame.card)||seen.has(frame.card)){
   throw unavailable();
  }
  if(frame.status===200){
   if(Object.keys(frame).length!==4||!('value' in frame))throw unavailable();
  }else if((frame.status!==400&&frame.status!==401&&frame.status!==403&&frame.status!==503)||Object.keys(frame).length!==3){
   throw unavailable();
  }
  seen.add(frame.card);
  const subscriber=subscribers.get(frame.card);
  if(!subscriber)return;
  if(frame.status===200&&'value' in frame)subscriber.complete(frame.value);
  else subscriber.fail();
 }

 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const query=new URLSearchParams({employmentId});
  if(requested.includes('calendar')&&month)query.set('month',month);
  if(requested.length!==DEFAULT_HOME_SHARING_CARDS.length||!DEFAULT_HOME_SHARING_CARDS.every(card=>requested.includes(card))){
   for(const card of requested)query.append('card',card);
  }
  const response=await fetch('/api/home/sharing-initial?'+query,{signal:controller.signal,cache:'no-store',credentials:'same-origin'});
  // An older server rejects the two newly requested card kinds (or month) at
  // validation, before invoking readers. Preserve its individual read protocol.
  // Authority/availability errors and malformed streams never trigger fallback.
  if(response.status===400&&requested.some(card=>card==='today'||card==='calendar')){
   await response.body?.cancel();
   await Promise.allSettled([...subscribers.values()].map(async subscriber=>{
    if(subscriber.signal.aborted)return;
    try{subscriber.complete(await subscriber.fallback());}catch{subscriber.fail();}
   }));
   return;
  }
  if(!response.ok||!response.body||response.headers.get('content-type')!==HOME_SHARING_STREAM)throw unavailable();
  reader=response.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const encoder=new TextEncoder();
  let buffer='',received=0;
  while(subscribers.size){
   const {value,done}=await reader.read();
   if(done){
    if(buffer||decoder.decode())throw unavailable();
    break;
   }
   received+=value.byteLength;
   if(received>requested.length*HOME_SHARING_MAX_FRAME_BYTES)throw unavailable();
   buffer+=decoder.decode(value,{stream:true});
   let end=buffer.indexOf('\n');
   while(end!==-1){
    const line=buffer.slice(0,end);
    if(encoder.encode(line).byteLength+1>HOME_SHARING_MAX_FRAME_BYTES)throw unavailable();
    deliver(line);
    buffer=buffer.slice(end+1);
    end=buffer.indexOf('\n');
   }
   if(buffer.length>=HOME_SHARING_MAX_FRAME_BYTES)throw unavailable();
  }
 }finally{
  for(const subscriber of subscribers.values())subscriber.fail();
  if(reader){
   try{await reader.cancel();}catch{/* Cancellation may already have reached fetch. */}
   reader.releaseLock();
  }
 }
}

function createSharingSubscription(employmentId:string,month?:string):Subscribe {
 let waiting:Map<HomeSharingCard,Subscriber>|undefined;
 return (card,signal,fallback)=>new Promise((resolve,reject)=>{
  if(signal.aborted){reject(unavailable());return;}
  if(!waiting){
   const batch=new Map<HomeSharingCard,Subscriber>();
   waiting=batch;
   queueMicrotask(()=>{
    waiting=undefined;
    if(batch.size===1){
     for(const subscriber of batch.values()){
      void subscriber.fallback().then(subscriber.complete,subscriber.fail);
     }
    }else if(batch.size>1){
     const controller=new AbortController();
     for(const subscriber of batch.values()){
      subscriber.signal.addEventListener('abort',()=>{
       if(!batch.size)controller.abort();
      },{once:true,signal:controller.signal});
     }
     void streamSharing(employmentId,batch,controller,month)
      .catch(()=>{/* The stream settles all outstanding subscribers. */})
      .finally(()=>controller.abort());
    }
   });
  }
  const batch=waiting;
  if(batch.has(card)){
   void fallback().then(resolve,reject);
   return;
  }
  const settle=(finish:()=>void)=>{
   if(batch.get(card)!==subscriber)return;
   batch.delete(card);
   signal.removeEventListener('abort',abort);
   finish();
  };
  const abort=()=>settle(()=>reject(unavailable()));
  const subscriber:Subscriber={signal,fallback,complete:value=>settle(()=>resolve(value)),fail:abort};
  batch.set(card,subscriber);
  signal.addEventListener('abort',abort,{once:true});
 });
}

export function HomeInitialSharing({employmentId,month,children}:{employmentId:string;month?:string;children:React.ReactNode}){
 const locale=useLocale();
 const subscribe=React.useMemo(()=>createSharingSubscription(employmentId,month),[employmentId,month,locale]);
 return <SharingCohort.Provider value={subscribe}>{children}</SharingCohort.Provider>;
}

export function useHomeInitialSharing(){
 return React.useContext(SharingCohort);
}
