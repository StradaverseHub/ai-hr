import {describe,it,expect} from 'vitest';
import {resolveRoutingRow,routingFromV9BpRules,routingProblems,routingRecipients,type Routing} from '../lib/automation/routing';

const u=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

describe('Shared routing rules',()=>{
 it('keeps existing empty-match semantics unless the module explicitly enables default fallback',()=>{
  const routing:Routing={id:'route',name:'Approver',rows:[
   {match:{company:['company']},assignTo:{kind:'group',groupId:'empty'}},
   {match:{},assignTo:{kind:'people',userIds:[u(1)]}},
  ]};
  expect(routingRecipients(routing,{company:'company'},()=>[]).userIds).toEqual([]);
  expect(routingRecipients(routing,{company:'company'},()=>[],{defaultOnEmpty:true}).userIds).toEqual([u(1)]);
 });
 it('preserves the historical PBP conversion outcomes after lifecycle routing removal, for every fact combination',()=>{
  const bpRules=[
   {rules:{businessGroup:['CHGB']},userId:u(1)},
   {rules:{businessGroup:['CHGB'],company:['SpaceX']},userId:u(2)},
   {rules:{department:['Finance']},userId:u(3)},
   {rules:{company:['SpaceX'],department:['Finance']},userId:u(4)},
   {rules:{businessGroup:['CHBM','CHCE']},userId:u(5)},
   {rules:{businessGroup:['CHBM']},userId:u(6)},
   {rules:{},userId:u(7)},
   {rules:{businessGroup:['CHGB'],department:['Finance']},userId:u(8)},
  ];
  const routing=routingFromV9BpRules(bpRules);
  let checked=0;
  for(const businessGroup of['CHGB','CHBM','CHCE','FIAMMA',''])for(const company of['SpaceX','CHGB Holdings',''])for(const department of['Finance','Sales','']){
   // Independently pinned historical outcomes; the retired lifecycle resolver is no longer callable.
   const expected = businessGroup === 'CHGB' ? company === 'SpaceX' ? 2 : department === 'Finance' ? 8 : 1
     : ['CHBM','CHCE'].includes(businessGroup) ? 5
     : department === 'Finance' ? company === 'SpaceX' ? 4 : 3 : 7;
   const shared=resolveRoutingRow(routing,{businessGroup,company,department});
   expect(shared?.row.assignTo).toEqual({kind:'people',userIds:[u(expected)]});checked++;
  }
  expect(checked).toBe(45);
 });
 it('lets a job title row win over the same row without it, and keeps list order between equals',()=>{
  const routing:Routing={id:'r',name:'HOD by business group and department',rows:[
   {match:{businessGroup:['FIAMMA']},assignTo:{kind:'group',groupId:'g-a'}},
   {match:{businessGroup:['FIAMMA'],jobTitle:['Senior Engineer']},assignTo:{kind:'people',userIds:[u(9)]}},
   {match:{businessGroup:['FIAMMA']},assignTo:{kind:'group',groupId:'g-b'}},
  ]};
  expect(resolveRoutingRow(routing,{businessGroup:'FIAMMA',jobTitle:'Senior Engineer'})?.index).toBe(1);
  expect(resolveRoutingRow(routing,{businessGroup:'FIAMMA',jobTitle:'Cashier'})?.index).toBe(0);
  expect(resolveRoutingRow(routing,{businessGroup:'CHGB'})).toBeNull();
 });
 it('as a recipient reaches everyone in the matched group or list, and says why when it reaches nobody',()=>{
  const groups:Record<string,string[]>={'g-gbs':[u(1),u(2),u(1)],'g-empty':[]};
  const members=(id:string)=>groups[id]??null;
  const routing=(assignTo:Routing['rows'][number]['assignTo']):Routing=>({id:'r',name:'BP by business group',rows:[{match:{businessGroup:['CHGB']},assignTo}]});
  expect(routingRecipients(routing({kind:'group',groupId:'g-gbs'}),{businessGroup:'CHGB'},members)).toEqual({userIds:[u(1),u(2)],missing:null});
  expect(routingRecipients(routing({kind:'people',userIds:[u(3),u(4)]}),{businessGroup:'CHGB'},members).userIds).toEqual([u(3),u(4)]);
  expect(routingRecipients(routing({kind:'group',groupId:'g-empty'}),{businessGroup:'CHGB'},members).missing).toContain('has no members');
  expect(routingRecipients(routing({kind:'group',groupId:'g-gone'}),{businessGroup:'CHGB'},members).missing).toContain('no longer exists');
  expect(routingRecipients(routing({kind:'group',groupId:'g-gbs'}),{businessGroup:'CHBM'},members).missing).toContain('No row');
 });
 it('validates rows at save time',()=>{
  const exists=(id:string)=>id==='g-gbs';
  expect(routingProblems({id:'r',name:'BP',rows:[{match:{businessGroup:['CHGB']},assignTo:{kind:'group',groupId:'g-gbs'}}]},exists)).toEqual([]);
  const problems=routingProblems({id:'r',name:' ',rows:[{match:{grade:['12']} as never,assignTo:{kind:'group',groupId:'g-x'}},{match:{},assignTo:{kind:'people',userIds:[]}}]},exists);
  expect(problems).toEqual(['Name this routing.','Row 1: unknown match grade.','Row 1: choose an existing assignment group.','Row 2: choose between 1 and 50 people.']);
 });
});
