/** REVIEW (security-surface) — the inbound identifier screen (core/harness/reply-checks.ts screenIdentifiers) and
 * what the scripted model is actually sent. Written as test/review/review-harness-identifiers.test.ts. No database.
 * Free-text and identifier FIELDS are removed structurally by disclosure; this screen is what protects the person's
 * own typed words, task memory and history. Its patterns are Malaysian-only; the product ships th, vi, zh and ta. */
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import {screenIdentifiers} from '../../core/harness/reply-checks';
import {HARNESS_TEST_ONLY,runTurn} from '../../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../../core/harness/memory';
import {fakeTools} from '../harness-ratchet/fake-tools';
import {scriptedModel} from '../harness-ratchet/scripted-model';

const employee:SessionContext={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',personId:'00000000-0000-4000-8000-0000000000cc',
 roles:['employee'],grants:[{role:'employee',companyId:null}]};
const SCOPE={companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'};
async function sentFor(question:string){
 const {provider}=fakeTools(),model=scriptedModel([{final:{reply:'Thanks, please check your profile page.',mode:'answer'}}]);
 await runTurn({enabled:HARNESS_TEST_ONLY,ctx:employee,conversationId:'review-identifiers',question,scope:SCOPE,model,memory:new InMemoryTaskMemoryStore(),tools:provider});
 return JSON.stringify(model.requests.map(request=>request.messages));
}

describe('identifier screen gaps',()=>{
 it.each([
  ['Thai national ID','My ID card number is 1-1037-02071-81-1.','1-1037-02071-81-1'],
  ['Vietnamese mobile','Call me on 0912 345 678.','0912 345 678'],
  ['Thai mobile','My number is 081-234-5678.','081-234-5678'],
  ['Singapore NRIC','My NRIC is S1234567D.','S1234567D'],
  ['Malaysian account in 3-6-3 groups','My bank account is 164-123456-789.','164-123456-789'],
 ])('REVIEW medium: a %s is removed before it is sent',(_kind,text,value)=>{
  const result=screenIdentifiers(text);
  expect(result.count).toBeGreaterThan(0);
  expect(result.text).not.toContain(value);
 });
 it('REVIEW medium: a Thai national ID typed by the person never reaches the model',async()=>{
  expect(await sentFor('My Thai ID is 1-1037-02071-81-1. Is my record complete?')).not.toContain('1-1037-02071-81-1');
 });
});

describe('REVIEW pass: identifiers the screen does remove',()=>{
 it.each([
  ['Malaysian IC','My IC is 900101-14-5678, is my EPF set up?','900101-14-5678'],
  ['Malaysian mobile','My phone is +60 12-345 6789.','12-345 6789'],
  ['email','Send it to aina.fictional@fixture.test please.','aina.fictional@fixture.test'],
  ['record id','Open 33333333-3333-4333-8333-333333333333 for me.','33333333-3333-4333-8333-333333333333'],
 ])('REVIEW pass: a %s typed by the person never reaches the model',async(_kind,question,value)=>{
  expect(await sentFor(question)).not.toContain(value);
 });
});
