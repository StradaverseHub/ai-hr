import { useState } from 'react';
import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChecklistEditor } from '../app/lifecycle/v9/workspace';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
function Editor() {
  const [config, setConfig] = useState(() => { const value = v9Defaults(); value.checklists = [{ ...value.checklists.find(checklist => checklist.module === 'onb')!, id: 'fixture', name: 'Fixture checklist', tasks: [{ id: 'fixture-task', name: 'Fictional task', by: 'group', group: value.groups[0]?.id ?? null, mode: 'rr', opens: null, due: 1, required: false, documentTemplate: null, documentAction: 'signed' }] }]; return value; });
  return <><ChecklistEditor config={config} module="onb" selected="fixture" select={() => {}} editable edit={change => setConfig(old => { const next = structuredClone(old); change(next); return next; })}/><output data-testid="config">{JSON.stringify(config)}</output></>;
}
it('persists manual assignment and required flags while locking assignment mode for a joiner-owned task', () => {
  render(<Editor/>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Assignment for Fictional task' }), { target: { value: 'manual' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Required: Fictional task' }));
  expect(JSON.parse(screen.getByTestId('config').textContent!).checklists[0].tasks[0]).toMatchObject({ id: 'fixture-task', mode: 'manual', required: true });
  fireEvent.change(screen.getByRole('combobox', { name: 'Completed by' }), { target: { value: 'employee' } });
  expect(screen.getByRole('combobox', { name: 'Assignment for Fictional task' })).toBeDisabled();
});

function ManagedEditor({ editable=true, owner='hr' }: {editable?:boolean;owner?:string}) {
  const [config,setConfig]=useState(()=>{const value=v9Defaults();value.checklists=[{id:'managed',name:'Managed checklist',module:'off',ownerUserId:owner,rules:{caseType:['Resignation']},tasks:[{id:'source-task',name:'Keep task',by:'employee',group:null,mode:'manual',opens:null,due:0,required:true,documentTemplate:null,documentAction:'signed'}]}];return value;});
  const [selected,select]=useState('managed');
  return <><ChecklistEditor config={config} module="off" selected={selected} select={select} actor={{id:'hr',name:'HR'}} users={[{id:'hr',name:'HR'},{id:'new-owner',name:'Next owner'},{id:'outsider',name:'Other user'}]} eligibleOwnerIds={['hr','new-owner']} editable={editable} edit={change=>setConfig(old=>{const next=structuredClone(old);change(next);return next;})}/><output data-testid="managed-config">{JSON.stringify(config)}</output></>;
}
it('places New above grouped checklist cards, duplicates independent task identities and selects the copy',()=>{
  render(<ManagedEditor/>);
  const nav=screen.getByRole('navigation',{name:'Checklists'});
  expect(nav.querySelector('button')?.textContent).toBe('New checklist');
  expect(screen.getByText('OWNED BY YOU')).toBeInTheDocument();expect(screen.getByText('Case type: Resignation')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Duplicate'}));
  const config=JSON.parse(screen.getByTestId('managed-config').textContent!);
  expect(config.checklists).toHaveLength(2);expect(config.checklists[1]).toMatchObject({name:'Copy of Managed checklist',ownerUserId:'hr'});
  expect(config.checklists[1].id).not.toBe(config.checklists[0].id);expect(config.checklists[1].tasks[0].id).not.toBe('source-task');
  expect(screen.getByRole('textbox',{name:'Checklist name'})).toHaveValue('Copy of Managed checklist');
});
it('transfers ownership only to offered module members and requires confirmation before deleting',()=>{
  render(<ManagedEditor/>);fireEvent.click(screen.getByRole('button',{name:'Change owner'}));
  expect(screen.queryByRole('option',{name:'Other user'})).toBeNull();
  fireEvent.change(screen.getByRole('combobox',{name:'New owner'}),{target:{value:'new-owner'}});fireEvent.click(screen.getByRole('button',{name:'Transfer ownership'}));
  expect(JSON.parse(screen.getByTestId('managed-config').textContent!).checklists[0].ownerUserId).toBe('new-owner');
  expect(screen.getByRole('button',{name:'Delete checklist'})).toBeDisabled();
});
it('deletes the last checklist only after explicit confirmation and leaves creation available',()=>{
  render(<ManagedEditor/>);fireEvent.click(screen.getByRole('button',{name:'Delete checklist'}));
  expect(JSON.parse(screen.getByTestId('managed-config').textContent!).checklists).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Confirm delete checklist'}));
  expect(JSON.parse(screen.getByTestId('managed-config').textContent!).checklists).toEqual([]);expect(screen.getByRole('button',{name:'New checklist'})).toBeEnabled();
});
it('keeps nonowners and view-only users from ownership and lifecycle actions',()=>{
  const view=render(<ManagedEditor owner="someone-else"/>);
  expect(screen.getByRole('button',{name:'Change owner'})).toBeDisabled();expect(screen.getByRole('button',{name:'Delete checklist'})).toBeDisabled();view.unmount();
  render(<ManagedEditor editable={false}/>);for(const name of ['New checklist','Duplicate','Change owner','Delete checklist'])expect(screen.getByRole('button',{name})).toBeDisabled();
});
