import {beforeEach,describe,expect,it,vi} from 'vitest';
import {useState} from 'react';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {Block} from '../lib/lifecycle-v9-model';
import type {DocumentRouting} from '../lib/document-signing-routing';
import {TemplateRoutingEditor,type RoutingChoices} from '../app/lifecycle/probation/templates/routing-editor';

/** The "Signing and review routing" section of a Probation letter template version (handoff A2; prototype TemplateEditor). */
vi.mock('../app/automation/actions',()=>({searchPeopleAction:vi.fn(async()=>({ok:true,result:[{id:'u-named',name:'Fictional Named Signatory'}]}))}));
const choices:RoutingChoices={routings:[{id:'r-bp',name:'BP by business group'}],groups:[{id:'g-gbs',name:'GBS People Ops'}],people:[]};
const letterBlocks:Block[]=[{id:'body',type:'text',text:'Dear {employeeName}',section:'main'},{id:'sig',type:'signature',text:'',section:'main',role:'hr',label:'For the company'}];
let counter=0,latest:{routing:DocumentRouting;blocks:Block[]}={routing:[],blocks:[]};
function Harness({initial=[],editable=true,teamSteps=false}:{initial?:DocumentRouting;editable?:boolean;teamSteps?:boolean}){
 const[routing,setRouting]=useState<DocumentRouting>(initial),[blocks,setBlocks]=useState<Block[]>(letterBlocks);
 latest={routing,blocks};
 return <TemplateRoutingEditor teamLabels={teamSteps?{pick:messages.resignationJourney.initialAssigneeRule,hint:messages.resignationJourney.letterTeamAssignmentHint}:undefined} value={routing} blocks={blocks} choices={choices} editable={editable} onChange={setRouting} onBlocksChange={setBlocks} newId={()=>'step-'+(++counter)}/>;
}
const show=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
const step=(n:number)=>within(screen.getByRole('group',{name:`Step ${n}`}));
beforeEach(()=>{counter=0;latest={routing:[],blocks:[]};});

describe('signing and review routing editor',()=>{
 it('starts empty with today’s behaviour and adds a Sign step for the employee',()=>{
  show(<Harness/>);
  expect(screen.getByRole('heading',{name:'Signing and review routing'})).toBeInTheDocument();
  expect(screen.getByText('No signing routing set. This letter uses the signing route below, as today.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Add signing step'}));
  expect(step(1).getByRole('spinbutton',{name:'Order'})).toHaveValue(1);
  expect(step(1).getByRole('combobox',{name:'Action'})).toHaveValue('sign');
  expect(step(1).getByRole('combobox',{name:'Who'})).toHaveValue('employee');
  expect(step(1).getByText('Signs the letter. The last step releases it. Signers can’t edit the text.')).toBeInTheDocument();
  expect(latest.routing).toEqual([{id:'step-1',order:1,action:'sign',who:{kind:'employee'},owner:false,pick:'any'}]);
 });
 it('flags an unlinked Sign step and signature block, and links the block to the step',()=>{
  show(<Harness/>);
  fireEvent.click(screen.getByRole('button',{name:'Add signing step'}));
  const problems=screen.getByRole('alert');
  expect(within(problems).getByText('Sign step 1 has no signature block, so that signature has nowhere to print. Add one in the content.')).toBeInTheDocument();
  expect(within(problems).getByText('Signature block 2 is not linked to a signing step.')).toBeInTheDocument();
  const link=screen.getByRole('combobox',{name:'Signature block 2'});
  expect(within(link).getByRole('option',{name:'hr (old setting — choose a step)'})).toBeInTheDocument();
  fireEvent.change(link,{target:{value:'step:step-1'}});
  expect(latest.blocks[1].role).toBe('step:step-1');
  expect(screen.queryByRole('alert')).toBeNull();
 });
 it('keeps one owner, offers the any-member or round-robin rule for routings and explains each action',()=>{
  show(<Harness initial={[{id:'a',order:1,action:'review',who:{kind:'group',groupId:'g-gbs'},owner:false},{id:'b',order:2,action:'sign',who:{kind:'employee'},owner:false}]}/>);
  expect(step(1).getByText(/Can edit the letter until the first signature/)).toBeInTheDocument();
  fireEvent.click(step(2).getByRole('checkbox',{name:'Owns the document'}));
  fireEvent.click(step(1).getByRole('checkbox',{name:'Owns the document'}));
  expect(step(1).getByRole('checkbox',{name:'Owns the document'})).toBeChecked();
  expect(step(2).getByRole('checkbox',{name:'Owns the document'})).not.toBeChecked();
  expect(step(1).getByText(/Send-backs come to this step/)).toBeInTheDocument();
  fireEvent.change(step(2).getByRole('combobox',{name:'Who'}),{target:{value:'routing:r-bp'}});
  fireEvent.change(step(2).getByRole('combobox',{name:'Choose one person by'}),{target:{value:'roundRobin'}});
  expect(latest.routing[1]).toMatchObject({who:{kind:'routing',routingId:'r-bp'},pick:'roundRobin'});
  fireEvent.change(step(2).getByRole('combobox',{name:'Action'}),{target:{value:'approve'}});
  expect(step(2).getByText('A decision with no signature. Shown in Approval Items.')).toBeInTheDocument();
  expect(within(screen.getByRole('alert')).getByText('At least one step must be a Sign step, or nobody signs the document.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Remove step 2'}));
  expect(latest.routing.map(s=>s.id)).toEqual(['a']);
 });
 it('names people for a step through the people search',async()=>{
  show(<Harness initial={[{id:'a',order:1,action:'sign',who:{kind:'employee'},owner:false}]}/>);
  fireEvent.change(step(1).getByRole('combobox',{name:'Who'}),{target:{value:'people'}});
  expect(within(screen.getByRole('alert')).getByText('Step 1: choose between 1 and 50 people.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox',{name:'Search people by name'}),{target:{value:'Fictional'}});
  fireEvent.click(screen.getByRole('button',{name:'Find'}));
  fireEvent.click(await screen.findByRole('button',{name:'Add Fictional Named Signatory'}));
  expect(latest.routing[0].who).toEqual({kind:'people',userIds:['u-named']});
  const remove=step(1).getByRole('button',{name:'Remove Fictional Named Signatory'});
  const selected=remove.closest('li')!;
  expect(within(selected).getByText('Fictional Named Signatory',{exact:true})).toBeVisible();
  expect(screen.queryByText('Step 1: a chosen person can no longer be found.')).toBeNull();
  expect(remove).toBeEnabled();
 });
 it('is read-only when the version cannot be edited',()=>{
  show(<Harness editable={false} initial={[{id:'a',order:1,action:'sign',who:{kind:'employee'},owner:true}]}/>);
  expect(step(1).getByRole('combobox',{name:'Action'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Add signing step'})).toBeDisabled();
  expect(screen.getByRole('combobox',{name:'Signature block 2'})).toBeDisabled();
 });
});

// The optional context is supplied only by Offboarding Letter templates; omitted preserves other consumers.
it.each([{kind:'group',groupId:'g-gbs'},{kind:'routing',routingId:'r-bp'},{kind:'people',userIds:['u-one','u-two']}] as const)('explains nonlocking team assignment for an Offboarding $kind step without changing the stored picking rule',who=>{
 show(<Harness teamSteps initial={[{id:'team',order:1,action:'review',who:who.kind==='people'?{kind:'people',userIds:[...who.userIds]}:who,owner:true,pick:'any'}]}/>);
 expect(step(1).getByRole('combobox',{name:'Initial assignee rule'})).toHaveValue('any');expect(step(1).getByText(messages.resignationJourney.letterTeamAssignmentHint)).toBeInTheDocument();expect(screen.queryByText(messages.probationLetters.routing.oneOfGroup)).not.toBeInTheDocument();
 fireEvent.change(step(1).getByRole('combobox',{name:'Initial assignee rule'}),{target:{value:'roundRobin'}});expect(latest.routing[0].pick).toBe('roundRobin');expect(latest.routing[0].owner).toBe(true);
});
it('preserves the existing single-holder explanation and picker label when the Offboarding context is absent',()=>{
 show(<Harness initial={[{id:'native',order:1,action:'review',who:{kind:'group',groupId:'g-gbs'},owner:true}]}/>);
 expect(step(1).getByRole('combobox',{name:'Choose one person by'})).toBeInTheDocument();expect(step(1).getByText(messages.probationLetters.routing.oneOfGroup)).toBeInTheDocument();expect(screen.queryByText(messages.resignationJourney.letterTeamAssignmentHint)).not.toBeInTheDocument();
});
