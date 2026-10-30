/** Synthetic review-state fixtures exercise opaque request custody; no provider/network/DB. */
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
const review=vi.hoisted(()=>({approved:true}));
vi.mock('../lib/ai/provider-data-reviews',()=>({assertProviderDataContractReviewed(){if(!review.approved)throw Error('Review pending');}}));
import {bindProviderPrivacyRequest,transferProviderPrivacyRequest,assertProviderPrivacyRequest,consumeProviderPrivacyRequest,revokeProviderPrivacyRequest} from '../lib/ai/provider-privacy-request';
import {captureAiConfig} from '../lib/ai/governance';
import {draftInputDigest} from '../lib/ai/draft-input';
import {generateDraft,converse,readImage} from '../lib/ai';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import type {ResolvedAiConfig} from '../lib/ai/types';
const cfg=():ResolvedAiConfig=>Object.freeze({provider:'anthropic',model:'synthetic',apiKey:'fictional-no-network',governance:Object.freeze({async run<T>(_request:unknown,call:(record:()=>void)=>Promise<T>){return call(()=>{});}})});
const args={system:'Fixed synthetic policy.',prompt:'Only synthetic categories.',maxTokens:1024};
const digest=draftInputDigest(args);
const binding=()=>({feature:'report_insight' as const,operation:'draft' as const,inputDigest:digest,contractId:'aggregate_comparison_analysis_v1',sourceDigest:createHash('sha256').update('synthetic-review').digest('hex'),expiresAt:Date.now()+60000});
afterEach(()=>{review.approved=true;vi.restoreAllMocks();vi.useRealTimers();});
it('rejects missing, copied, serialized, wrong feature/operation/digest and expired bindings',()=>{
 const c=cfg();expect(()=>assertProviderPrivacyRequest(c,'draft',digest)).toThrow();bindProviderPrivacyRequest(c,binding());
 expect(()=>assertProviderPrivacyRequest(c,'draft',digest,'report_insight')).not.toThrow();
 for(const copy of [{...c},JSON.parse(JSON.stringify(c))])expect(()=>assertProviderPrivacyRequest(copy,'draft',digest)).toThrow();
 expect(()=>assertProviderPrivacyRequest(c,'conversation',digest)).toThrow();expect(()=>assertProviderPrivacyRequest(c,'draft','f'.repeat(64))).toThrow();expect(()=>assertProviderPrivacyRequest(c,'draft',digest,'payroll_explanation')).toThrow();
 expect(()=>bindProviderPrivacyRequest(c,binding())).toThrow();
 vi.useFakeTimers();vi.advanceTimersByTime(60001);expect(()=>assertProviderPrivacyRequest(c,'draft',digest)).toThrow();
});
it('preserves one shared use through canonical capture/derivation, never a second capability',()=>{
 const c=cfg(),next=cfg();bindProviderPrivacyRequest(c,binding());transferProviderPrivacyRequest(c,next);const captured=captureAiConfig(next);
 expect(()=>assertProviderPrivacyRequest(captured,'draft',digest)).not.toThrow();consumeProviderPrivacyRequest(captured,'draft',digest);
 for(const retained of [c,next,captured])expect(()=>assertProviderPrivacyRequest(retained,'draft',digest)).toThrow();
});
it('rechecks review status on admission and dispatch instead of trusting preparation',()=>{
 const c=cfg();bindProviderPrivacyRequest(c,binding());review.approved=false;
 expect(()=>assertProviderPrivacyRequest(c,'draft',digest)).toThrow('Review pending');expect(()=>consumeProviderPrivacyRequest(c,'draft',digest)).toThrow('Review pending');
 review.approved=true;expect(()=>consumeProviderPrivacyRequest(c,'draft',digest)).not.toThrow();
});
it('uses one exact prepared synthetic request and refuses resending or substituted text',async()=>{
 const c=cfg();bindProviderPrivacyRequest(c,binding());const generate=vi.spyOn(anthropicAdapter,'generate').mockResolvedValue('Synthetic comparison');
 await expect(generateDraft(c,{...args,prompt:'Private injected name'})).rejects.toThrow();expect(generate).not.toHaveBeenCalled();
 await expect(generateDraft(c,args)).resolves.toBe('Synthetic comparison');expect(generate).toHaveBeenCalledOnce();
 await expect(generateDraft(c,args)).rejects.toThrow();expect(generate).toHaveBeenCalledOnce();
});
it('keeps unknown raw requests out of every workload operation without admitting them',async()=>{
 let admissions=0;const c:ResolvedAiConfig=Object.freeze({provider:'anthropic',model:'synthetic',apiKey:'fictional',governance:{async run(){admissions++;throw Error('Unexpected admission');}}});
 await expect(generateDraft(c,{system:'Private policy',prompt:'Private person'})).rejects.toThrow('reviewed data-protection policy');
 await expect(converse(c,{system:['Private policy'],turns:[{role:'user',content:'Private name'}],tools:[]})).rejects.toThrow('reviewed data-protection policy');
 const bytes=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
 await expect(readImage(c,{data:bytes,mimeType:'image/png'})).rejects.toThrow();expect(admissions).toBe(0);
});

it('revokes all captured views when a prepared analysis is disposed before admission',()=>{
 const c=cfg();bindProviderPrivacyRequest(c,binding());const retained=captureAiConfig(c);revokeProviderPrivacyRequest(c);
 expect(()=>assertProviderPrivacyRequest(retained,'draft',digest)).toThrow();expect(()=>consumeProviderPrivacyRequest(c,'draft',digest)).toThrow();
});
