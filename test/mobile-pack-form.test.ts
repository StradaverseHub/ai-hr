import {describe,it,expect} from 'vitest';
import {validPackValues,action,choiceField,numberField,boolField,textField,projectPackPeople} from '../lib/mobile-api/pack-form';
import {PackWorkspaceCommand,PackField,type PackWorkspace} from '../lib/mobile-api/v2/pack-workspaces';
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

it('pages large review populations and keeps only the selected person’s complete facts and actions',()=>{
 const people=Array.from({length:1000},(_,i)=>({id:`${i.toString(16).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,name:`Synthetic person ${i}`}));
 const w:PackWorkspace={kind:'calibration',id:people[0].id,title:'Cohort',today:'2026-11-01',revision:1,expected:{digest:'a'.repeat(64)},documents:[],blocks:[{id:'session',title:'Scope',rows:[]},...people.flatMap(p=>[{id:p.id,title:p.name,rows:[{label:'Evidence',value:`Complete evidence for ${p.name}`}]},{id:`talent:${p.id}`,title:'Talent context',rows:[]}])],actions:[...people.map(p=>action(`save:performance:${p.id}`,p.name,'Record decision')),action('lock:performance','Lock cohort','Finalize this cohort')]};
 const selected=projectPackPeople(w,people,{offset:25})!;expect(selected.navigation).toMatchObject({offset:25,total:1000,focus:people[25].id,hasMore:true});expect(selected.navigation!.people).toHaveLength(25);expect(selected.blocks.map(b=>b.id)).toEqual(['session',people[25].id,`talent:${people[25].id}`]);expect(selected.actions.map(a=>a.id)).toEqual([`save:performance:${people[25].id}`,'lock:performance']);expect(selected.expected).toEqual(w.expected);expect(JSON.stringify(selected)).not.toContain('Complete evidence for Synthetic person 24');
 expect(projectPackPeople(w,people,{offset:1000})!.navigation).toMatchObject({offset:975,hasMore:false});
 expect(projectPackPeople(w,people,{offset:0,focus:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})).toBeNull();
});

it('supports the owner’s full competency statement as a native form label',()=>{
 expect(PackField.safeParse({...textField('comment',`Technical · ${'Full statement '.repeat(140)}`),kind:'text'}).success).toBe(true);
});
