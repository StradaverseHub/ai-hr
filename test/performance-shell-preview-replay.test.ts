import {expect,it,vi} from 'vitest';
import {createShellPreviewReplay} from '../scripts/performance/shell-preview-replay.mjs';

const user={role:'employee'};
const complete={
 headers:{'cache-control':'private, no-store'},durationMs:320,content:JSON.stringify({
  approvals:{state:'ready',items:[],total:1,approvalCount:1,claimTotal:0},
  lifecycle:{count:0,items:[]},
 }),
};

it('starts a separate preview, cancels it before the next document, and measures only completed previews',async()=>{
 const read=vi.fn().mockImplementationOnce((_user,signal:AbortSignal)=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 })).mockResolvedValueOnce(complete);
 const replay=createShellPreviewReplay(read,(values:number[])=>values.slice());
 const actor=replay.actor(user);
 actor.start();
 expect(read).toHaveBeenCalledOnce();
 expect(()=>actor.start()).toThrow(/Only one shell preview/);
 await actor.replace();
 expect(read.mock.calls[0][1].aborted).toBe(true);
 actor.start();
 await actor.finish();
 expect(replay.snapshot()).toEqual({employee:{
  started:2,ready:1,unavailable:0,failed:0,navigationCancelled:1,readyLatency:[320],
 }});
});

it('keeps unavailability and bad responses out of usable previews',async()=>{
 const read=vi.fn().mockResolvedValueOnce({...complete,content:JSON.stringify({approvals:{state:'unavailable'}})})
  .mockResolvedValueOnce({...complete,content:'not a preview'});
 const replay=createShellPreviewReplay(read,(values:number[])=>values.length);
 const actor=replay.actor(user);
 actor.start();
 await actor.finish();
 await actor.replace();
 actor.start();
 await actor.finish();
 expect(replay.snapshot()).toEqual({employee:{
  started:2,ready:0,unavailable:1,failed:1,navigationCancelled:0,readyLatency:0,
 }});
});
