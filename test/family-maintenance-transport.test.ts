/** Actual browser packet/stream parser, without mocking the transport or reaching a server. */
import {describe,expect,it} from 'vitest';
import {checkGenericPacket,readGenericModuleActionResponse} from '../components/assistant/generic-module-action-transport';
import {FamilyMaintenance as C} from '../lib/assistant-actions/family-maintenance-contract';
const employmentId='11111111-1111-4111-8111-111111111111',personId='22222222-2222-4222-8222-222222222222',actionId='33333333-3333-4333-8333-333333333333',dependentId='44444444-4444-4444-8444-444444444444';
const confirmation={action:C.action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64)};
const fields=C.Fields.parse({fullName:'Fictional Family',relationship:'child',dateOfBirth:null,gender:null,icOrPassport:null,phone:null,remarks:null,passportNumber:null,residentialAddress:null,deceasedOn:null,marriageDate:null,marriageStatus:null,occupation:null,companyName:null,employerAddress:null,schoolName:null,studyLevel:null,studyCountry:null,childReliefCategory:null,isBeneficiary:false,isDeceased:false,spouseWorking:null,isStudent:null,childTaxRelief:null,childReliefPercentage:null});
const input=C.Human.parse({action:C.action,contractVersion:1,employmentId,subjectId:personId,operation:'add',dependentId:null,fields});
const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
describe('Family browser transport registration',()=>{
 it('admits all six actual family operations and preserves strict human input',()=>{
  for(const raw of [{action:C.action,operation:'choices',selection:{query:'',employmentId}},{action:C.action,operation:'list'},{action:C.action,operation:'prepare',input},{action:C.action,operation:'reopen',actionId},{action:C.action,operation:'confirm',confirmation},{action:C.action,operation:'discard',confirmation:{action:C.action,contractVersion:1,actionId}}])expect(checkGenericPacket(raw)).toEqual(raw);
  expect(checkGenericPacket({action:C.action,operation:'prepare',input:{...input,fields:{...fields,bankAccountNo:'not a family field'}}})).toBeNull();
  expect(checkGenericPacket({action:C.action,operation:'confirm',confirmation:{...confirmation,eventId:dependentId}})).toBeNull();
 });
 it('reads a valid complete family review larger than the generic32KiB response limit',async()=>{
  const archive=C.Human.parse({...input,operation:'archive',dependentId,fields:null}),packet=checkGenericPacket({action:C.action,operation:'prepare',input:archive});if(!packet)throw Error('Family packet registration missing');
  const review=C.Prepared.parse({action:C.action,contractVersion:1,actionId,reviewedDigest:confirmation.reviewedDigest,createdAt:'2026-10-30T00:00:00.000Z',expiresAt:'2026-10-30T00:15:00.000Z',content:archive,review:{employmentId,subjectId:personId,employeeName:'Fictional Employee',employeeCode:null,companyName:'Fictional Company',operation:'archive',dependentId,before:{...fields,fullName:'漢'.repeat(4000),remarks:'漢'.repeat(4000),residentialAddress:'漢'.repeat(4000)},after:null,relief:{changed:false,before:null,after:null,payrollAlert:null,skipped:'manual_mode',values:null},sharedPerson:true},consequence:C.consequence}),body={kind:'prepared',review};
  const bytes=new TextEncoder().encode(JSON.stringify(body)).byteLength;expect(bytes).toBeGreaterThan(32768);expect(bytes).toBeLessThan(120000);
  expect(await readGenericModuleActionResponse(response(body),packet)).toEqual(body);
 });
 it('still refuses a wrong-family-subject response and another saved action id',async()=>{
  const packet=checkGenericPacket({action:C.action,operation:'reopen',actionId});if(!packet)throw Error('Family packet registration missing');
  await expect(readGenericModuleActionResponse(response({kind:'retired',receipt:{action:C.action,contractVersion:1,actionId:dependentId,state:'expired'}}),packet)).rejects.toThrow();
  const prepare=checkGenericPacket({action:C.action,operation:'prepare',input});if(!prepare)throw Error('Family packet registration missing');
  const review={action:C.action,contractVersion:1,actionId,reviewedDigest:confirmation.reviewedDigest,createdAt:'2026-10-30T00:00:00.000Z',expiresAt:'2026-10-30T00:15:00.000Z',content:input,review:{employmentId,subjectId:dependentId,employeeName:'Fictional Employee',employeeCode:null,companyName:'Fictional Company',operation:'add',dependentId:null,before:null,after:fields,relief:{changed:false,before:null,after:null,payrollAlert:null,skipped:'no_statutory_row',values:null},sharedPerson:true},consequence:C.consequence};
  await expect(readGenericModuleActionResponse(response({kind:'prepared',review}),prepare)).rejects.toThrow();
 });
});
