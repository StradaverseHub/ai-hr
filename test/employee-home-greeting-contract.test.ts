import {describe,expect,it} from 'vitest';
import {todayInKualaLumpur} from '../lib/hr-date';
import {homeGreetingMessage,validateHomeGreetingCommand,validateHomeGreetingReceipt} from '../lib/employee-home-greeting';

const sender='00000000-0000-4000-8000-000000000001',recipient='00000000-0000-4000-8000-000000000002';
const nonce='00000000-0000-4000-8000-000000000003',greeting='00000000-0000-4000-8000-000000000004';
const command=()=>({version:1,employmentId:sender,recipientEmploymentId:recipient,kind:'birthday',
 occurrenceDate:todayInKualaLumpur(),nonce,message:'Happy birthday, Fictional 李 தமிழ் ไทย Nguyễn 🎉!'});
describe('explicit Home greeting command boundary',()=>{
 it('preserves edited Unicode and treats markup as plain text without sending anything',()=>{
  const edited={...command(),message:'  Hello <b>Fictional 李</b> 🎉\r\nHave a good day!  '};
  expect(validateHomeGreetingCommand(edited).message).toBe('Hello <b>Fictional 李</b> 🎉\nHave a good day!');
  expect(edited.message.startsWith('  ')).toBe(true);
 });
 it('refuses posted identity/authority and private presentation fields instead of ignoring them',()=>{
  for(const field of ['senderUserId','personId','companyId','roles','approved','name','dateOfBirth','years','notification'])
   expect(()=>validateHomeGreetingCommand({...command(),[field]:'untrusted'})).toThrow();
  for(const field of Object.keys(command())){
   const missing:Record<string,unknown>={...command()};delete missing[field];
   expect(()=>validateHomeGreetingCommand(missing)).toThrow();
  }
 });
 it('requires an exact selected EMP, distinct target, occurrence kind/date and retry nonce',()=>{
  for(const change of [{version:2},{employmentId:''},{recipientEmploymentId:sender},{nonce:null},
   {nonce:'00000000-0000-0000-0000-000000000000'},{kind:'automatic'},{occurrenceDate:'2026-02-30'}])
   expect(()=>validateHomeGreetingCommand({...command(),...change})).toThrow();
 });
 it('bounds Unicode by characters and refuses lossy or invisible control input',()=>{
  expect(homeGreetingMessage('🎉'.repeat(500))).toHaveLength(1000);
  for(const text of ['', ' \n ', '🎉'.repeat(501), 'A'.repeat(501), 'hello\u0000world', '\u000Bhello', 'hello\u000C', '\uD800', '\uDC00'])
   expect(()=>homeGreetingMessage(text)).toThrow();
 });
 it('binds both terminal receipt states to this exact sender and retry without exposing content',()=>{
  for(const state of ['sent','erased']){
   const receipt={version:1,employmentId:sender,nonce,greetingId:greeting,state};
   expect(validateHomeGreetingReceipt(receipt,{employmentId:sender,nonce})).toEqual(receipt);
   expect(()=>validateHomeGreetingReceipt(receipt,{employmentId:recipient,nonce})).toThrow();
   expect(()=>validateHomeGreetingReceipt(receipt,{employmentId:sender,nonce:greeting})).toThrow();
   expect(()=>validateHomeGreetingReceipt({...receipt,message:'private body'},{employmentId:sender,nonce})).toThrow();
  }
 });
});
