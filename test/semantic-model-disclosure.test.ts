/** ADR-0170 §2 principle 4 over the generated outputs: disclosure classes hold in every spec, and no
 * spec carries a name or an identifier. Fictional fixture values only; no database. */
import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {SEMANTIC_ACTIONS,SEMANTIC_ENTITIES,SEMANTIC_READS} from '../core/semantic-model/entities';
import {capabilityRegistry,connectToolSpecs,contextToolSpecs,disclosureOf} from '../core/semantic-model/generate';
import type {SemanticField} from '../core/semantic-model/types';

const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);
const allFields=()=>SEMANTIC_ENTITIES.flatMap(entity=>walk(entity.fields).map(field=>({entity,field})));
const neverNames=()=>[...new Set(allFields().filter(row=>row.field.disclosure==='never').map(row=>row.field.name))];
/** Every property key and its tag in an output schema, at any depth. */
function properties(schema:unknown):Array<{key:string;value:Record<string,unknown>}>{
 if(!schema||typeof schema!=='object')return[];
 const node=schema as Record<string,unknown>,own=node.properties&&typeof node.properties==='object'?Object.entries(node.properties as Record<string,Record<string,unknown>>):[];
 return[...own.flatMap(([key,value])=>[{key,value},...properties(value)]),...properties(node.items)];
}
const deepFrozen=(value:unknown):boolean=>!value||typeof value!=='object'||(Object.isFrozen(value)&&Object.values(value).every(deepFrozen));
// A fictional population a careless generator could leak: none of it may appear in any generated spec.
const FIXTURE={names:['Fictional Aisyah Rahman','Fictional Tan Wei Ming'],codes:['FX-0042','FX-0043'],ids:[randomUUID(),randomUUID()],emails:['fictional.applicant@example.test']};

describe('declared disclosure classes',()=>{
 it('classes every identifier, code and typed free text as never',()=>{
  for(const {entity,field} of allFields())if(['id','code','text'].includes(field.type))expect(field.disclosure,entity.id+'.'+field.name).toBe('never');
 });
 it('releases every money figure of a pay subject only as a band',()=>{
  for(const {entity,field} of allFields())
   if(entity.sensitivity==='pay'&&entity.module==='payroll'&&['number','object'].includes(field.type)&&!field.of)expect(field.disclosure,entity.id+'.'+field.name).toBe('bands');
 });
 it('summarises each capability\'s disclosure from its entity, every field exactly once',()=>{
  for(const row of capabilityRegistry()){
   const entity=SEMANTIC_ENTITIES.find(candidate=>candidate.id===row.entity)!;
   expect(row.disclosure).toEqual(disclosureOf(entity.fields));
   expect(Object.values(row.disclosure).flat()).toHaveLength(walk(entity.fields).length);
  }
 });
});

describe('generated specs enforce the classes',()=>{
 it('never names a `never` field in a context spec description',()=>{
  for(const spec of contextToolSpecs())for(const name of neverNames())
   expect(spec.description,spec.name+' mentions '+name).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`));
 });
 it('keeps `never` fields out of every Connect output schema and tags every property with its class',()=>{
  const specs=connectToolSpecs();expect(specs.length).toBeGreaterThan(0);
  for(const spec of specs.filter(row=>row.annotations.readOnlyHint)){
   const read=SEMANTIC_READS.find(row=>'teras_'+row.name===spec.name)!,entity=SEMANTIC_ENTITIES.find(row=>row.id===read.entity)!;
   const declared=new Map(walk(entity.fields).map(field=>[field.name,field]));
   for(const {key,value} of properties(spec.outputSchema)){
    expect(value['x-teras-disclosure'],spec.name+'.'+key).not.toBe('never');
    expect(['bands','minimum','full']).toContain(value['x-teras-disclosure']);
    if(value['x-teras-disclosure']==='bands')expect(value.type,spec.name+'.'+key).toBe('string');
    expect(declared.get(key)?.disclosure,spec.name+'.'+key).not.toBe('never');
   }
   for(const [name,field] of declared)if(field.disclosure==='never')expect(properties(spec.outputSchema).filter(row=>row.key===name&&row.value['x-teras-disclosure']==='never')).toEqual([]);
  }
 });
 it('offers Connect no read that needs an identifier handle and no unmigrated action',()=>{
  const names=connectToolSpecs().map(spec=>spec.name);
  for(const read of SEMANTIC_READS)expect(names.includes('teras_'+read.name)).toBe(read.input.every(input=>!input.identifier));
  expect(names.filter(name=>name.startsWith('teras_prepare_'))).toEqual(['teras_prepare_leave_apply']);
  const prepare=connectToolSpecs().find(spec=>spec.name==='teras_prepare_leave_apply')!;
  expect(prepare.annotations).toEqual({readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false});
  expect(Object.keys(prepare.inputSchema.properties)).toEqual(['date']);
 });
 it('carries no name, identifier, code or address in any generated output',()=>{
  const text=JSON.stringify([capabilityRegistry(),contextToolSpecs(),connectToolSpecs()]);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  for(const value of [...FIXTURE.names,...FIXTURE.codes,...FIXTURE.ids,...FIXTURE.emails])expect(text).not.toContain(value);
  expect(text).not.toMatch(/Fictional/);
 });
 it('is generated once, deterministic and deeply frozen',()=>{
  expect(contextToolSpecs()).toBe(contextToolSpecs());expect(connectToolSpecs()).toBe(connectToolSpecs());
  for(const value of [SEMANTIC_ENTITIES,SEMANTIC_READS,SEMANTIC_ACTIONS,capabilityRegistry(),contextToolSpecs(),connectToolSpecs()])expect(deepFrozen(value)).toBe(true);
 });
});
