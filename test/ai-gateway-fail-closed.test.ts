/** TEST ONLY: synthetic privacy-review seam for this legacy gateway-control suite. The new
 * disclosure assertion/consumption is isolated so the original protocol, capture, source, admission,
 * spend and accounting controls below are still exercised. Actual binding/transfer/revocation and
 * provider egress dispatch remain real. Dedicated provider-privacy-request, provider-data-review-gate
 * and ai-private-analysis suites exercise the real default-block/review policy separately. This
 * fixture grants no production review status and admits no real provider data. */
vi.mock('../lib/ai/provider-privacy-request', async importActual => {
  const actual = await importActual<typeof import('../lib/ai/provider-privacy-request')>();
  return { ...actual, assertProviderPrivacyRequest: () => {}, consumeProviderPrivacyRequest: () => {} };
});

import {describe,it,expect,vi} from 'vitest';
import {generateDraft,converse,readImage,validateConfig,type ResolvedAiConfig} from '../lib/ai';
import {governed,createUngovernedProbe,type UngovernedProbe} from '../lib/ai/governance';
import {openaiAdapter} from '../lib/ai/providers/openai';
const cfg:ResolvedAiConfig={provider:'openai',model:'fixture',apiKey:'fixture'};
describe('R9 gateway fail-closed',()=>{
 it('refuses hand-built configs before generation or conversation transport',async()=>{
  const draft=vi.spyOn(openaiAdapter,'generate'),chat=vi.spyOn(openaiAdapter,'converse'),image=vi.spyOn(openaiAdapter,'readImage');
  try{
   await expect(generateDraft(cfg,{system:'fixture',prompt:'fixture'})).rejects.toThrow('governance is required');
   await expect(converse(cfg,{system:['fixture'],turns:[{role:'user',content:'fixture'}],tools:[]})).rejects.toThrow('governance is required');
   const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8R0AAAAASUVORK5CYII=','base64'));
   await expect(readImage(cfg,{data:png,mimeType:'image/png'})).rejects.toThrow();
   expect(draft).not.toHaveBeenCalled();expect(chat).not.toHaveBeenCalled();expect(image).not.toHaveBeenCalled();
  }finally{draft.mockRestore();chat.mockRestore();image.mockRestore();}
 });
 it('refuses a forged probe brand and never calls the supplied transport',()=>{
  const transport=vi.fn();expect(()=>governed({...cfg} as UngovernedProbe,{operation:'probe',reservedTokens:0},transport)).toThrow('governance is required');
  expect(transport).not.toHaveBeenCalled();
 });
 it('allows only the connection check through an explicit issued probe and records failed results',async()=>{
  const log:string[]=[];
  const probe=createUngovernedProbe(cfg,async(request,call)=>{log.push(request.operation);const result=await call(()=>{});log.push('settled');return result;});
  const validate=vi.spyOn(openaiAdapter,'validate').mockResolvedValue({ok:false,error:'generic'});
  try{
   await expect(validateConfig(probe)).resolves.toEqual({ok:false,error:'generic'});
   expect(log).toEqual(['probe','settled']);
   await expect(generateDraft(probe,{system:'fixture',prompt:'fixture'})).rejects.toThrow('cannot execute');
   expect(validate).toHaveBeenCalledTimes(1);
  }finally{validate.mockRestore();}
 });
});
