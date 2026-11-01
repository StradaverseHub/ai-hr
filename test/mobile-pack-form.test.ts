import {describe,it,expect} from 'vitest';
import {validPackValues,action,choiceField,numberField,boolField,textField} from '../lib/mobile-api/pack-form';
import {PackWorkspaceCommand} from '../lib/mobile-api/v2/pack-workspaces';
describe('native pack form admission',()=>{
 const a=action('review','Review','Records the review',[choiceField('band','Band',['ME','AE']),numberField('actual','Actual'),boolField('ack','Acknowledgement',true),{...textField('reason','Reason','',true),minLength:10},{key:'date',label:'Date',kind:'date',value:null,required:true}]);
 const valid={band:'ME',actual:0,ack:true,reason:'Reviewed evidence',date:'2026-11-01'};
 it('accepts a complete exact map including zero and rejects forged fields/choices/types',()=>{
  expect(validPackValues(a,valid)).toBe(true);
  for(const values of [{...valid,companyId:'forged'},{...valid,band:'invented'},{...valid,actual:'0'},{...valid,actual:Infinity},{...valid,ack:false},{...valid,reason:'short'},{...valid,date:'2026-02-30'},{...valid,date:'2026-11-01T00:00:00Z'}])expect(validPackValues(a,values)).toBe(false);
  const {ack,...missing}=valid;expect(validPackValues(a,missing)).toBe(false);
 });
 it('refuses prototype keys, nonfinite values and oversized commands',()=>{
  const base={requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',action:'review',expected:{digest:'0'.repeat(64)}};
  expect(PackWorkspaceCommand.safeParse({...base,values:JSON.parse('{"__proto__":"pollution"}')}).success).toBe(false);
  expect(PackWorkspaceCommand.safeParse({...base,values:{constructor:'pollution'}}).success).toBe(false);
  expect(PackWorkspaceCommand.safeParse({...base,values:{reason:'x'.repeat(4001)}}).success).toBe(false);
  expect(PackWorkspaceCommand.safeParse({...base,values:{actual:NaN}}).success).toBe(false);
  expect(PackWorkspaceCommand.safeParse({...base,values:Object.fromEntries(Array.from({length:1001},(_,i)=>[String(i),0]))}).success).toBe(false);
 });
});
