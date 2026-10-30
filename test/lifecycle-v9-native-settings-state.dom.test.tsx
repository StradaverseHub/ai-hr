import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { OnboardingSettings } from '../app/admin/lifecycle/onboarding/settings';
import { defaultConfig } from '../lib/onboarding-model';
const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('../app/lifecycle/onboarding/v31-actions', () => ({ saveOnboardingConfig: mocks.save, saveOnboardingChecklistTasks: vi.fn() }));
const messages = JSON.parse(readFileSync('messages/en.json','utf8'));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function context(revision = 7) { return { config: defaultConfig('owner'), revision, actor: {id:'owner',module:true,master:true}, directory:[{id:'owner',name:'Owner'}], checklistCounts:{},loads:{},availability:{},matchCounts:{},totalJoiners:0 } as Parameters<typeof OnboardingSettings>[0]['context']; }
const options = {businessGroup:[],company:[],department:[],title:[],grade:[],employmentType:[],supervisor:[]};
function Harness({ value }: { value: ReturnType<typeof context> }) {
  const [view,setView] = useState('settings');
  return <NextIntlClientProvider locale="en" messages={messages}><button onClick={()=>setView('away')}>Away</button><button onClick={()=>setView('groups')}>Groups view</button><div hidden={view==='away'}><OnboardingSettings context={value} options={options} embedded initialTab={view==='groups'?'groups':'settings'}/></div></NextIntlClientProvider>;
}
it('retains hidden pending settings and serializes a later group edit against the acknowledged revision', async () => {
  vi.useFakeTimers(); let first!: (value: {error:null;revision:number}) => void;
  mocks.save.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValue({error:null,revision:9});
  const value=context(); render(<Harness value={value}/>);
  fireEvent.click(screen.getByRole('checkbox',{name:'Count equipment and access in onboarding progress'}));
  fireEvent.click(screen.getByRole('button',{name:'Away'}));
  await act(async()=>{vi.advanceTimersByTime(600);});
  expect(mocks.save).toHaveBeenCalledWith(7,expect.objectContaining({countEquipment:false}),{},false);
  fireEvent.click(screen.getByRole('button',{name:'Groups view'}));
  fireEvent.change(within(screen.getByRole('region',{name:value.config.groups[0].name})).getByRole('textbox',{name:'Group name'}),{target:{value:'Fictional changed group'}});
  await act(async()=>{vi.advanceTimersByTime(600);}); expect(mocks.save).toHaveBeenCalledTimes(1);
  await act(async()=>{first({error:null,revision:8});});
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save.mock.calls[1]).toEqual([8,expect.objectContaining({countEquipment:false,groups:expect.arrayContaining([expect.objectContaining({id:value.config.groups[0].id,name:'Fictional changed group'})])}),{},false]);
});
it('adopts a fresh Native revision when idle before starting another edit', async () => {
  vi.useFakeTimers(); mocks.save.mockResolvedValue({error:null,revision:10});
  const view=render(<Harness value={context()}/>), fresh=context(9); fresh.config.groups[0].name='Fresh canonical group';
  view.rerender(<Harness value={fresh}/>);
  fireEvent.click(screen.getByRole('checkbox',{name:'Count equipment and access in onboarding progress'}));
  await act(async()=>{vi.advanceTimersByTime(600);});
  expect(mocks.save).toHaveBeenCalledWith(9,expect.objectContaining({groups:expect.arrayContaining([expect.objectContaining({name:'Fresh canonical group'})])}),{},false);
});

it('autosaves embedded module access through the canonical settings writer',async()=>{
  vi.useFakeTimers();mocks.save.mockResolvedValue({error:null,revision:8});const value=context();
  render(<NextIntlClientProvider locale="en" messages={messages}><OnboardingSettings context={value} options={options} embedded initialTab="access"/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('checkbox',{name:'Owner offboarding access'}));
  await act(async()=>{vi.advanceTimersByTime(600);});
  expect(mocks.save).toHaveBeenCalledWith(7,expect.objectContaining({access:{onboarding:['owner'],offboarding:['owner']}}),{},false);
});
