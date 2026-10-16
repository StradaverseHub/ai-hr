/** Real renderer client, mocked socket only. No UDS, service, filesystem or database is used. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
const wire=vi.hoisted(()=>({reply:null as unknown,requests:[] as unknown[],behavior:'reply' as 'reply'|'error'|'oversize'|'partial'}));
vi.mock('node:net',async importOriginal=>{
  const original=await importOriginal<typeof import('node:net')>(),{EventEmitter}=await import('node:events');
  return {...original,Socket:class extends EventEmitter{
    setTimeout(){return this;}
    connect(_path:string,ready:()=>void){queueMicrotask(ready);return this;}
    end(body:string){wire.requests.push(JSON.parse(body));queueMicrotask(()=>{
      if(wire.behavior==='error'){this.emit('error',new Error('private socket detail'));return;}
      this.emit('data',Buffer.from(wire.behavior==='oversize'?'x'.repeat(4097):wire.behavior==='partial'?'{':JSON.stringify(wire.reply)));
      this.emit('end');
    });return this;}
    destroy(){return this;}
  }};
});
import {authorizeReportArtifact,authorizeMasterReportFile} from '../deploy/identity-email/render-process';
import type {MasterDeliveryTarget} from '../deploy/identity-email/reports';
import {fingerprintReportBytes} from '../lib/employee-master-artifact';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE} from '../lib/email-attachment';
const input={occurrenceId:randomUUID(),leaseToken:randomUUID(),expectedAccessStamp:'a'.repeat(64)};
const artifact=fingerprintReportBytes(Buffer.from('PK fixture workbook'),XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE);
beforeEach(()=>{wire.requests=[];wire.behavior='reply';wire.reply={ok:true,accessStamp:input.expectedAccessStamp,artifact};});
describe('direct authoritative renderer artifact client',()=>{
  it('obtains a typed fingerprint directly and sends only fixed authorize IDs and stamp',async()=>{
    expect(await authorizeReportArtifact(input)).toEqual({accessStamp:input.expectedAccessStamp,artifact});
    expect(wire.requests).toEqual([{phase:'authorize',...input}]);
  });
  it('cannot promote an extra caller phase/path/digest into the socket request',async()=>{
    await authorizeReportArtifact({...input,phase:'render',path:'/other',artifact:{sha256:'b'.repeat(64)}} as unknown as typeof input);
    expect(wire.requests).toEqual([{phase:'authorize',...input}]);
  });
  it('preserves the compatibility boolean for an older access-only reply, while refusing it as artifact authority',async()=>{
    wire.reply={ok:true,accessStamp:input.expectedAccessStamp};
    expect(await authorizeMasterReportFile(input.occurrenceId,input.leaseToken,{accessStamp:input.expectedAccessStamp} as MasterDeliveryTarget)).toBe(true);
    await expect(authorizeReportArtifact(input)).rejects.toMatchObject({reason:'generationFailed'});
  });
  it.each([
    {ok:true,accessStamp:'b'.repeat(64),artifact},
    {ok:true,accessStamp:input.expectedAccessStamp,artifact:{...artifact,sha256:'A'.repeat(64)}},
    {ok:true,accessStamp:input.expectedAccessStamp,artifact:{...artifact,byteLength:0}},
    {ok:true,accessStamp:input.expectedAccessStamp,artifact:{...artifact,contentType:'application/octet-stream'}},
    {ok:true,accessStamp:input.expectedAccessStamp,artifact:{...artifact,path:'/tmp/workbook'}},
    {ok:true,accessStamp:input.expectedAccessStamp,artifact,email:'caller@example.test'},
  ])('refuses mismatched, malformed or extra reply fields: %j',async reply=>{
    wire.reply=reply;await expect(authorizeReportArtifact(input)).rejects.toMatchObject({reason:'generationFailed'});
  });
  it.each(['notEligible','generationFailed','attachmentTooLarge'] as const)('preserves finite renderer refusal %s',async reason=>{
    wire.reply={ok:false,reason};await expect(authorizeReportArtifact(input)).rejects.toMatchObject({reason});
  });
  it.each(['error','oversize','partial'] as const)('refuses %s without reflecting private transport details',async behavior=>{
    wire.behavior=behavior;await expect(authorizeReportArtifact(input)).rejects.toMatchObject({reason:'generationFailed',message:'Report preparation was refused.'});
  });
});
