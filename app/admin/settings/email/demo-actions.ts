'use server';
import {randomUUID} from 'node:crypto';
import {headers} from 'next/headers';
import {getSession} from '@/lib/session';
import {isAdmin} from '@/lib/authz';
import {demoSwitcherEnabled} from '@/lib/demo-mode';
import {withTenant} from '@/db/client';
import {appendEvent,actorOf} from '@/db/events';
import {demoSmtpSchema,type DemoSmtpResult} from '@/lib/demo-smtp-model';
import {probeDemoSmtp} from '@/lib/demo-smtp-probe';
import {demoSmtpBudget} from '@/lib/demo-smtp-budget';

export async function testDemoSmtpConnection(form:FormData):Promise<DemoSmtpResult>{
  let release:(()=>void)|undefined;
  try{
    if(!demoSwitcherEnabled())return {status:'error',code:'forbidden'};
    // Middleware overwrites this header. Auth-flow routes bypass the hosting challenge;
    // an action ID invoked there must not grant access to this demo network capability.
    if((await headers()).get('x-pathname')!=='/admin/settings/email')return {status:'error',code:'forbidden'};
    const s=await getSession();
    if(!s.userId||!isAdmin(s))return {status:'error',code:'forbidden'};
    const text=(key:string)=>typeof form.get(key)==='string'?form.get(key) as string:undefined;
    const parsed=demoSmtpSchema.safeParse({host:text('host'),port:Number(text('port')),security:text('security'),
      auth:text('auth')==='true',user:text('user'),password:text('password')});
    if(!parsed.success||!['true','false'].includes(text('auth')??''))return {status:'error',code:'invalid'};
    const slot=demoSmtpBudget.acquire(s.tenantId+':'+s.userId);
    if(!slot)return {status:'error',code:'busy'};
    release=slot;
    const id=randomUUID();
    const audit=(eventType:string,payload:Record<string,unknown>)=>withTenant(s,tx=>appendEvent(tx,{
      tenantId:s.tenantId,aggregateType:'demo-smtp-test',aggregateId:id,eventType,actor:actorOf(s),payload:{demo:true,...payload},
    }));
    // Durable intent before egress; audit stores only the attempt ID and result category.
    await audit('demo.smtp.test-requested',{});
    const result=await probeDemoSmtp(parsed.data);
    await audit('demo.smtp.test-finished',result.status==='success'?{outcome:'success',authenticated:result.authenticated}:{outcome:result.code});
    return result;
  }catch{return {status:'error',code:'unavailable'};}
  finally{release?.();}
}
