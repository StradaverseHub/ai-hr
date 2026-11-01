/** Authenticated thread metadata is local custody, never a persisted continuation capability. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {captureAssistantThreadMetadata,openAssistantAnswerDisclosure,sealAssistantDisclosure} from '../lib/ai/assistant-disclosure';
import {decryptSecret,encryptSecret} from '../lib/ai/crypto';
beforeEach(()=>vi.stubEnv('AI_CONFIG_SECRET','fictional-thread-disclosure-key'));afterEach(()=>vi.unstubAllEnvs());
const fixture=()=>({tenantId:randomUUID(),userId:randomUUID(),exchangeId:randomUUID(),question:'Hello',answer:JSON.stringify({version:1,mode:'social',code:'greeting'})});
const aad=(b:ReturnType<typeof fixture>)=>JSON.stringify(['ai-hr.assistant-disclosure.v1',b.tenantId,b.userId,b.exchangeId]);
describe('v3 local saved-chat receipt',()=>{
 it('authenticates exact thread/scope alongside owner, body and existing source proof without saving a token',()=>{
  const b=fixture(),thread={threadId:b.exchangeId,scopeDigest:'a'.repeat(64)},token=sealAssistantDisclosure(b,[],{version:1,mode:'social',code:'greeting'},thread)!;
  expect(openAssistantAnswerDisclosure(b,token)).toEqual({reads:[],plan:{version:1,mode:'social',code:'greeting'},thread});
  const plain=JSON.parse(decryptSecret(token,aad(b)));expect(Object.keys(plain).sort()).toEqual(['body','plan','reads','thread','v']);expect(plain.thread).toEqual(thread);expect(Object.isFrozen(openAssistantAnswerDisclosure(b,token)!.thread)).toBe(true);
  for(const key of ['tenantId','userId','exchangeId','question','answer'] as const)expect(openAssistantAnswerDisclosure({...b,[key]:randomUUID()},token)).toBeNull();
 });
 it('preserves exact legacy v1/v2 meanings and refuses malformed or extra v3 metadata',()=>{
  const b=fixture(),plan={version:1 as const,mode:'social' as const,code:'greeting' as const};
  expect(openAssistantAnswerDisclosure(b,sealAssistantDisclosure(b,[]))).toEqual({reads:[],plan:null});
  expect(openAssistantAnswerDisclosure(b,sealAssistantDisclosure(b,[],plan))).toEqual({reads:[],plan});
  const token=sealAssistantDisclosure(b,[],plan,{threadId:b.exchangeId,scopeDigest:'b'.repeat(64)})!,raw=JSON.parse(decryptSecret(token,aad(b)));
  for(const thread of [{threadId:b.exchangeId,scopeDigest:'short'},{threadId:'bad',scopeDigest:'b'.repeat(64)},{threadId:b.exchangeId,scopeDigest:'b'.repeat(64),conversationToken:'forged'}])expect(openAssistantAnswerDisclosure(b,encryptSecret(JSON.stringify({...raw,thread}),aad(b)))).toBeNull();
 });
 it('does not execute getters/proxies while capturing a claimed metadata object',()=>{
  let touched=false;const source={threadId:randomUUID(),get scopeDigest(){touched=true;return 'a'.repeat(64);}};
  expect(()=>captureAssistantThreadMetadata(source)).toThrow('Assistant thread unavailable.');expect(touched).toBe(false);
  expect(()=>captureAssistantThreadMetadata(new Proxy({threadId:randomUUID(),scopeDigest:'a'.repeat(64)},{getPrototypeOf(){touched=true;return Object.prototype;}}))).toThrow();expect(touched).toBe(false);
 });
});
