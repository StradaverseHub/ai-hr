import {describe,expect,it} from 'vitest';
import {parseAccessEditorMetadata} from '../lib/access-editor-data';
import type {AccessSnapshot} from '../lib/access-permission-model';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=id(1),user=id(2),company=id(3),event=id(4);
const snapshot:AccessSnapshot={tenantId:tenant,revision:id(5),users:[{id:user,active:true}],groups:[],memberships:[],overrides:[]};
const raw=()=>({users:[{id:user,label:'Fictional user'}],companies:[{id:company,label:'Fictional company'}],history:[{id:event,at:'2026-01-01T00:00:00Z',actorId:user,operation:'createGroup'}]});
describe('minimized access editor data',()=>{
 it('preserves the supplied audit order and only approved public fields',()=>{
  const source={...raw(),users:[{...raw().users[0],salary:'DO-NOT-SERIALIZE'}],history:[{...raw().history[0],payload:{private:'DO-NOT-SERIALIZE'}}],recoveryUserIds:[user]};
  const parsed=parseAccessEditorMetadata(source,snapshot,new Set([company]));
  expect(parsed.users).toEqual([{id:user,label:'Fictional user'}]);expect(parsed.history[0]).toEqual({id:event,at:'2026-01-01T00:00:00.000Z',actorId:user,operation:'createGroup'});
  expect(JSON.stringify(parsed)).not.toContain('DO-NOT-SERIALIZE');expect(parsed).not.toHaveProperty('recoveryUserIds');
 });
 it('refuses incomplete/duplicate/foreign labels, unknown operations and malformed audit timestamps',()=>{
  const invalid=[null,{...raw(),users:[]},{...raw(),companies:[{id:id(99),label:'Foreign'}]},
   {...raw(),users:[raw().users[0],raw().users[0]]},{...raw(),history:[{...raw().history[0],operation:'invented'}]},
   {...raw(),history:[{...raw().history[0],at:'not-a-date'}]},{...raw(),history:Array(101).fill(raw().history[0])}];
  for(const value of invalid)expect(()=>parseAccessEditorMetadata(value,snapshot,new Set([company]))).toThrow(/invalid/);
 });
});
