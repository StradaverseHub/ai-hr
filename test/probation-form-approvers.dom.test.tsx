/** Form editor approver choices (lane G1, owner mockup screen 10): Review / Approve / Approve and sign and who = a routing, an assignment group, named people or the Direct Superior. Fictional data only. */
import {describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {useState} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {ApprovalRoutingFields} from '../app/lifecycle/probation/approval-routing-fields';
import {DEFAULT_PROBATION_FORM,probationApprovalIssues,type ProbationForm} from '../lib/probation-form';

const choices={routings:[{id:'00000000-0000-4000-8000-0000000000a1',name:'Fictional BP by business group'}],groups:[{id:'fictional-approvers',name:'Fictional approvers'}]};
const users=[{id:'00000000-0000-4000-8000-0000000000b1',name:'Fictional Reviewer'},{id:'00000000-0000-4000-8000-0000000000b2',name:'Fictional Second Reviewer'}];
function Harness({onChange}:{onChange:(value:ProbationForm)=>void}){
 const [value,setValue]=useState<ProbationForm>(()=>structuredClone(DEFAULT_PROBATION_FORM));
 return <NextIntlClientProvider locale="en" messages={messages}><ApprovalRoutingFields value={value} change={next=>{setValue(next);onChange(next);}} disabled={false} users={users} choices={choices}/></NextIntlClientProvider>;
}
const partThree=()=>screen.getAllByRole('group').find(group=>group.getAttribute('data-part')==='3')!;

describe('form approval routing editor',()=>{
 it('offers Review, Approve and Approve and sign, and who as a holder, a routing, a group or named people',()=>{
  render(<Harness onChange={()=>{}}/>);
  const row=within(partThree()).getAllByRole('combobox',{name:'Action'})[0];
  expect(within(row).getAllByRole('option').map(option=>option.textContent)).toEqual(['Review','Approve','Approve and sign']);
  const who=within(partThree()).getAllByRole('combobox',{name:'Who'})[0];
  // The PBP row already exists in Part 3, so it is not offered twice; routings, groups and named people always are.
  expect(within(who).getAllByRole('option').map(option=>option.textContent)).toEqual(['Head of Department','Direct Superior','A routing','An assignment group','Named people']);
  expect(screen.getByRole('note').textContent).toMatch(/one person, chosen by the step’s rule when the Line Manager submits/);
 });

 it('saves a group row with its rule, a routing row and a named-people row as rows the model accepts',()=>{
  const changes:ProbationForm[]=[];render(<Harness onChange={value=>changes.push(value)}/>);
  const [first,second]=within(partThree()).getAllByRole('combobox',{name:'Who'});
  fireEvent.change(first,{target:{value:'group'}});
  fireEvent.change(within(partThree()).getAllByRole('combobox',{name:'Action'})[0],{target:{value:'approve'}});
  fireEvent.change(within(partThree()).getByRole('combobox',{name:'Who takes it'}),{target:{value:'roundRobin'}});
  fireEvent.change(second,{target:{value:'routing'}});
  expect(within(partThree()).getByRole('combobox',{name:'Routing'})).toHaveValue(choices.routings[0].id);
  fireEvent.click(within(partThree()).getByRole('button',{name:'Add approval step'}));
  const people=within(partThree()).getAllByRole('combobox',{name:'Who'})[2];
  fireEvent.change(people,{target:{value:'people'}});
  const list=within(partThree()).getByRole('listbox',{name:'People'}) as HTMLSelectElement;
  for(const option of Array.from(list.options))option.selected=true;
  fireEvent.change(list);
  fireEvent.change(within(partThree()).getAllByRole('combobox',{name:'Action'})[2],{target:{value:'review'}});
  const last=changes.at(-1)!;
  expect(last.approvals!['3']).toEqual([
   {id:'step_1',order:1,action:'approve',who:'group:fictional-approvers',pick:'roundRobin'},
   {id:'step_2',order:2,action:'approve_sign',who:'routing:'+choices.routings[0].id,pick:'any'},
   {id:'step_3',order:3,action:'review',who:'people',pick:'any',userIds:users.map(user=>user.id)},
  ]);
  expect(probationApprovalIssues(last)).toEqual([]);
 });

 it('flags a Part 3 that only reviews: someone independent must approve the outcome',()=>{
  const form=structuredClone(DEFAULT_PROBATION_FORM);
  form.approvals!['3']=[{id:'step_1',order:1,action:'review',who:'superior'}];
  expect(probationApprovalIssues(form)).toContain('3:approval_required');
  form.approvals!['3']=[{id:'hod',order:1,action:'approve',who:'people',userIds:[]}];
  expect(probationApprovalIssues(form)).toEqual(expect.arrayContaining(['3:id','3:hod:people']));
 });
});
