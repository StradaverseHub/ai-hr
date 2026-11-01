/** ADR-0170 §3.12, step 5c — every kit-generated capability inherits the standard contracts.
 *
 * The first block runs every contract for every entry of core/improvement/kit-registry.ts: adding a capability
 * there is all it takes to be tested. The second proves each contract fails on a deliberately broken
 * capability, so a passing contract means something. No database, no provider. */
import {describe,expect,it} from 'vitest';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {STANDARD_CONTRACTS,kitCapability,type KitCapability} from '../core/improvement/kit';
import {runStandardContracts} from '../core/improvement/kit-contracts';
import type {SemanticField} from '../core/semantic-model/types';

describe('standard contracts hold for every kit capability',()=>{
 it('has capabilities to check',()=>{expect(KIT_CAPABILITIES.length).toBeGreaterThanOrEqual(4);});
 for(const capability of KIT_CAPABILITIES)for(const contract of STANDARD_CONTRACTS)it(`${capability.read.name}: ${contract}`,async()=>{
  expect((await runStandardContracts(capability))[contract]).toEqual([]);
 });
});

describe('each contract fails on a broken capability',()=>{
 const base=KIT_CAPABILITIES.find(row=>row.read.name==='explain_attendance_day')!;
 const findings=async(capability:KitCapability)=>runStandardContracts(capability);
 /** A declaration the kit would refuse, built past the kit to prove the contract catches it independently. */
 const unchecked=(change:Partial<KitCapability>):KitCapability=>({...base,...change,bind:change.bind??base.bind});
 const withFields=(fields:readonly SemanticField[])=>unchecked({declaration:{...base.declaration,entity:{...base.declaration.entity,fields}}});
 const fields=base.declaration.entity.fields;

 it('acts_as_person: an owner handed another session or an undeclared input',async()=>{
  const impostor=unchecked({bind:owner=>({...base.bind(owner),run:(_ctx,input,scope)=>owner({tenantId:'x'} as never,input as never,scope)})});
  expect((await findings(impostor)).acts_as_person).toEqual(expect.arrayContaining(['owner did not receive the caller\'s session',expect.stringMatching(/^owner received undeclared inputs/)]));
  const wide=unchecked({declaration:{...base.declaration,input:[{name:'employee_id',identifier:false,schema:{type:'string'}}],entity:{...base.declaration.entity,rls:'visible_employments'}}});
  expect((await findings(wide)).acts_as_person).toEqual(expect.arrayContaining(['own audience with a wider row scope','input employee_id selects a subject without being a handle']));
 });
 it('no_identifiers: an id disclosed as minimum',async()=>{
  const leaky=withFields([...fields,{name:'date',type:'id',disclosure:'minimum',meaning:'A record id shadowing the date.'}].filter((field,index,all)=>all.findLastIndex(other=>other.name===field.name)===index));
  expect((await findings(leaky)).no_identifiers).toEqual(['date is an identifier not declared never','entity differs from the one registered in the semantic model']);
 });
 it('other_person_refusal: a drafted turn the gate leaves open',async()=>{
  const open=unchecked({corpus:base.corpus.map(turn=>turn.contract==='other_person_refusal'?{...turn,question:'Show me my attendance day explanation.',ideal:{mode:'answer',reads:[]}}:turn)});
  expect((await findings(open)).other_person_refusal).toEqual(['the gate does not close the other-person turn','the other-person turn does not expect a refusal']);
 });
 it('no_overclaim: a description that says it changed something',async()=>{
  const claims=unchecked({toolSpec:{...base.toolSpec,description:'I have updated your attendance record.'},corpus:base.corpus.map(turn=>turn.contract==='no_overclaim'?{...turn,ideal:{mode:'propose',action:'attendance.correction.request'}}:turn)});
  expect((await findings(claims)).no_overclaim).toEqual(expect.arrayContaining([expect.stringMatching(/^description claims a change/),'a drafted turn expects a proposal','the change request does not expect an honest gap']));
 });
 it('minimum_fields: free text disclosed, a never field named, an undeclared key kept',async()=>{
  const chatty=withFields([...fields,{name:'note',type:'text',disclosure:'minimum',meaning:'What the person typed.'},{name:'secretCode',type:'code',disclosure:'never',meaning:''}]);
  const named=unchecked({...chatty,card:{...chatty.card,fields:[...chatty.card.fields,'secretCode']}});
  expect((await findings(named)).minimum_fields).toEqual(expect.arrayContaining(['note discloses free text','secretCode has no meaning','never field secretCode is named']));
 });
 it('a kit-generated capability over an unregistered entity cannot pass no_identifiers',async()=>{
  const unregistered=kitCapability({...base.declaration,entity:{...base.declaration.entity,id:'fictional_unregistered' as never}});
  expect((await findings(unregistered)).no_identifiers).toContain('entity is not registered in the semantic model, so its disclosure cannot run');
 });
});
