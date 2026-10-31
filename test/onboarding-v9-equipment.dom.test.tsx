import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OnboardingEquipment } from '../components/onboarding-equipment';
import * as M from '../lib/onboarding-model';
const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('../app/(app)/lifecycle/onboarding/v31-actions', () => ({ changeOnboarding: mocks.save }));
function fixture() {
  const config = M.defaultConfig('owner'); config.v9ChecklistRevision = 1; config.groups = [{id:'team',name:'Fulfilling team',members:['owner'],limit:0}]; config.techGroup = 'team';
  config.catalogue = [{id:'device',name:'Fictional device',type:'device',active:true,rules:{},workflow:null,team:'team',card:false}];
  const env = {now:'2026-10-30T00:00:00Z',today:'2026-10-30',id:()=> 'item',nextNumber:()=> 'IT-REQ-1',users:['owner'],leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{}};
  const c = M.blankCase('case','OB-1','draft',{fullName:'Fictional joiner',joinDate:'2026-11-01',company:'company',department:'department',title:'title',supervisor:'owner'},env); c.hiring = 'new_hire'; c.selected = ['device'];
  const actor = {id:'owner',name:'Owner',module:true,hr:true,master:true};
  return { c, config, actor, env, directory:[{id:'owner',name:'Owner'}], revision:7 };
}
it('keeps pending equipment preferences in the case draft until the existing save action runs', () => {
  const props = fixture(), change = vi.fn();
  render(<OnboardingEquipment {...props} draft={{ids:['device'],values:{},change}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Set for all items'}));
  fireEvent.change(screen.getByRole('combobox',{name:'Assignment for all items'}),{target:{value:'manual'}});
  fireEvent.change(screen.getByRole('textbox',{name:'Due by Day for all items'}),{target:{value:'-3'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply to all items'}));
  expect(change).toHaveBeenCalledWith({device:{method:'manual',due:-3}}); expect(mocks.save).not.toHaveBeenCalled();
});
it('uses original requisition item IDs and revision and retains choices after a rejected live bulk save', async () => {
  const props = fixture(); M.submitCase(props.config,props.c,props.actor,props.env); mocks.save.mockResolvedValue({error:'Case changed. Reload before saving.'});
  render(<OnboardingEquipment {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'Set for all items'}));
  fireEvent.change(screen.getByRole('combobox',{name:'Team for all items'}),{target:{value:'team'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply to all items'}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith('case',7,{type:'equipmentBulk',ids:['item'],group:'team'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Case changed');
  expect(screen.getByRole('combobox',{name:'Team for all items'})).toHaveValue('team');
});
