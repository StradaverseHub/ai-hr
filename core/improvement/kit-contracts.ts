/** ADR-0170 §3.12, step 5c — the standard contracts every kit-generated capability inherits.
 *
 *  - acts_as_person: the binding hands the owner the caller's own session and only the declared inputs; an
 *    undeclared input (a subject id slipped in by a model) never reaches it; an own-scope entity has an own row
 *    scope; no input selects a subject unless it is a handle from an earlier result.
 *  - no_identifiers: every id and code field is `never`, the entity is the one registered in the semantic model
 *    (the harness discloses by that), and a sample result disclosed by the harness's own disclosure
 *    (core/harness/disclosure.ts) leaves no record id, code or typed free text.
 *  - other_person_refusal: the drafted other-person turn is closed by the pre-read gate as `other_person`
 *    (no private read), and its ideal is a refusal.
 *  - no_overclaim: purpose and tool description claim no change (the product's own reply check), the
 *    capability is a read, and no drafted turn expects a proposal.
 *  - minimum_fields: every field states its meaning, free text is never disclosed, the description and card
 *    name no `never` field, and an undeclared key in a result is removed.
 * Each contract returns findings; none means it holds. test/capability-kit-contracts.test.ts runs every
 * contract for every entry of ./kit-registry.ts, so a capability gets them by being generated, and proves each
 * contract fails on a deliberately broken declaration. Pure apart from the spy owner it calls. */
import type {SessionContext} from '../../db/client';
import {gateTurn} from '../../lib/product-context/request-gate';
import {DisclosureLedger,discloseToolOutput} from '../harness/disclosure';
import {overclaim} from '../harness/reply-checks';
import {isDeepStrictEqual} from 'node:util';
import {disclosureOf,terasEntities} from '../semantic-model/generate';
import type {SemanticField} from '../semantic-model/types';
import type {KitCapability,StandardContract} from './kit';

const SAMPLE_ID='0f3c9a52-7d41-4c1e-9b8a-2e6d5f4a3b21',SAMPLE_SUBJECT='5a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const SAMPLE_CODE='CODE-778899',SAMPLE_TEXT='free text a person typed about Siti Fictional',UNDECLARED='undeclaredExtraKey';
const SUBJECT_INPUT=/(?:^|_)(?:tenant|user|person|employee|employment|staff|member)(?:_?id)?$/i;
const OWN_SCOPES:ReadonlySet<string>=new Set(['own_employment','own_person','own_holiday_calendar','own_module_scope']);

/** A fictional result with one value per declared field, of the field's type. */
export function sampleResult(fields:readonly SemanticField[]):Record<string,unknown>{
 const value=(field:SemanticField):unknown=>{switch(field.type){
  case 'id':return SAMPLE_ID;case 'code':return SAMPLE_CODE;case 'text':return SAMPLE_TEXT;case 'name':return 'Aina Fictional';case 'label':return 'Fictional label';
  case 'date':return '2026-07-01';case 'datetime':return '2026-07-01T09:00:00+08:00';case 'time':return '09:00';case 'period':return '2026-08';
  case 'number':return 12.5;case 'integer':return 3;case 'boolean':return true;case 'enum':return field.values?.[0]??'value';
  case 'list':return field.of?[sampleResult(field.of)]:['2026-07-01'];case 'object':return field.of?sampleResult(field.of):{flag:true};}};
 return Object.fromEntries(fields.map(field=>[field.name,value(field)]));
}
const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);
const fakeCaller=():SessionContext=>({tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',roles:['employee']} as SessionContext);

async function actsAsPerson(capability:KitCapability):Promise<string[]>{
 const findings:string[]=[],{entity,input}=capability.declaration;
 if(entity.audience==='self'&&!OWN_SCOPES.has(entity.rls))findings.push('own audience with a wider row scope');
 for(const row of input)if(SUBJECT_INPUT.test(row.name)&&!row.identifier)findings.push('input '+row.name+' selects a subject without being a handle');
 const caller=fakeCaller(),seen:{ctx:SessionContext;args:Readonly<Record<string,string|undefined>>}[]=[];
 const binding=capability.bind(async(ctx,args)=>{seen.push({ctx,args});return{ok:true};});
 const supplied:Record<string,unknown>={...Object.fromEntries(input.map(row=>[row.name,'2026-07-01'])),employment_id:SAMPLE_SUBJECT,personId:SAMPLE_SUBJECT,tenantId:SAMPLE_SUBJECT};
 await binding.run(caller,supplied,{companyId:'00000000-0000-4000-8000-000000000003'});
 if(seen.length!==1)findings.push('owner was not called exactly once');
 else{if(seen[0].ctx!==caller)findings.push('owner did not receive the caller\'s session');
  const extra=Object.keys(seen[0].args).filter(key=>!input.some(row=>row.name===key));if(extra.length)findings.push('owner received undeclared inputs: '+extra.join(', '));
  if(!input.some(row=>row.identifier)&&JSON.stringify(seen[0].args).includes(SAMPLE_SUBJECT))findings.push('a subject id reached the owner');}
 return findings;
}
/** The harness discloses by the REGISTERED entity, so a capability's own copy must be that entity. */
const registered=(capability:KitCapability)=>terasEntities().find(row=>row.id===capability.declaration.entity.id)??null;
function disclose(capability:KitCapability){
 const entity=capability.declaration.entity;
 if(!registered(capability))return null;
 return discloseToolOutput(capability.read.name,entity.id,{...sampleResult(entity.fields),[UNDECLARED]:SAMPLE_TEXT},new DisclosureLedger('kit-contract'));
}
function noIdentifiers(capability:KitCapability):string[]{
 const findings=walk(capability.declaration.entity.fields).filter(field=>(field.type==='id'||field.type==='code')&&field.disclosure!=='never').map(field=>field.name+' is an identifier not declared never');
 const disclosed=disclose(capability);
 if(!disclosed)return[...findings,'entity is not registered in the semantic model, so its disclosure cannot run'];
 if(!isDeepStrictEqual(registered(capability),capability.declaration.entity))findings.push('entity differs from the one registered in the semantic model');
 const text=JSON.stringify(disclosed.value);
 for(const [value,what] of [[SAMPLE_ID,'a record id'],[SAMPLE_CODE,'a code'],[SAMPLE_TEXT,'typed free text']] as const)if(text.includes(value))findings.push('disclosed result carries '+what);
 return findings;
}
function otherPersonRefusal(capability:KitCapability):string[]{
 const turn=capability.corpus.find(row=>row.contract==='other_person_refusal');
 if(!turn)return['no other-person turn drafted'];
 const gate=gateTurn(turn.question),findings:string[]=[];
 if(gate.privateReads||gate.reason!=='other_person')findings.push('the gate does not close the other-person turn');
 if(turn.ideal.mode!=='refuse')findings.push('the other-person turn does not expect a refusal');
 return findings;
}
function noOverclaim(capability:KitCapability):string[]{
 const findings:string[]=[];
 for(const [what,text] of [['purpose',capability.read.purpose],['description',capability.toolSpec.description]] as const){const claim=overclaim(text);if(claim)findings.push(what+' claims a change: '+claim);}
 if(capability.registryRow.effect!=='read')findings.push('a kit capability is a read');
 if(capability.corpus.some(row=>row.ideal.mode==='propose'))findings.push('a drafted turn expects a proposal');
 if(capability.corpus.find(row=>row.contract==='no_overclaim')?.ideal.mode!=='honest_gap')findings.push('the change request does not expect an honest gap');
 return findings;
}
function minimumFields(capability:KitCapability):string[]{
 const fields=walk(capability.declaration.entity.fields),findings:string[]=[];
 for(const field of fields){if(!field.meaning.trim())findings.push(field.name+' has no meaning');if(field.type==='text'&&field.disclosure!=='never')findings.push(field.name+' discloses free text');}
 const never=new Set(disclosureOf(capability.declaration.entity.fields).never),open=new Set([...disclosureOf(capability.declaration.entity.fields).minimum,...disclosureOf(capability.declaration.entity.fields).full,...disclosureOf(capability.declaration.entity.fields).bands]);
 const words=new Set(capability.toolSpec.description.split(/[\s,.:;()]+/));
 for(const path of never)if(!open.has(path)&&(words.has(path)||capability.card.fields.includes(path)))findings.push('never field '+path+' is named');
 const disclosed=disclose(capability);
 if(disclosed&&!disclosed.applied.undeclared.includes(UNDECLARED))findings.push('an undeclared key was not removed');
 return findings;
}

/** Findings per contract; an empty list means the contract holds. */
export async function runStandardContracts(capability:KitCapability):Promise<Readonly<Record<StandardContract,readonly string[]>>>{
 return Object.freeze({acts_as_person:await actsAsPerson(capability),no_identifiers:noIdentifiers(capability),other_person_refusal:otherPersonRefusal(capability),
  no_overclaim:noOverclaim(capability),minimum_fields:minimumFields(capability)});
}
