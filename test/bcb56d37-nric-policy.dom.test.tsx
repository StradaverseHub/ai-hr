import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
import PeopleGeneralPage from '../app/admin/settings/people-general/page';
const mocks=vi.hoisted(()=>({policy:{allowDuplicatedNric:false,revision:null as string|null},allowed:true}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'fixture'})}));
vi.mock('../core/people-general',()=>({canConfigurePeopleGeneral:async()=>mocks.allowed,getPeopleGeneral:async()=>mocks.policy}));
vi.mock('../app/admin/settings/people-general/actions',()=>({savePeopleGeneralAction:async()=>{}}));
vi.mock('next/navigation',()=>({redirect:(to:string)=>{throw new Error(`redirect:${to}`);}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=> (key:string,values?:Record<string,string>)=>{
 let text=key.split('.').reduce<unknown>((node,key)=>(node as Record<string,unknown>)[key],en.peopleGeneral) as string;
 for(const [key,value]of Object.entries(values??{}))text=text.replace(`{${key}}`,value);return text;
}}));

describe('People > General approved setting',()=>{
 it('renders OFF with a named accessible switch, required explanation and reversible unsaved edits',async()=>{
  mocks.allowed=true;mocks.policy={allowDuplicatedNric:false,revision:null};
  const {container}=render(await PeopleGeneralPage({searchParams:Promise.resolve({})}));
  const toggle=screen.getByRole('switch',{name:/Allow Duplicated NRIC/});expect(toggle).not.toBeChecked();
  expect(screen.getByText('Current setting: OFF')).toBeInTheDocument();
  expect(screen.getByText(en.peopleGeneral.offExplanation)).toBeInTheDocument();
  expect(screen.getByText(en.peopleGeneral.preserveExisting)).toBeInTheDocument();
  expect(screen.getByText(en.peopleGeneral.authority)).toBeInTheDocument();
  fireEvent.click(toggle);expect(toggle).toBeChecked();fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(toggle).not.toBeChecked();
  expect(screen.getByRole('button',{name:'Save setting'})).toHaveAttribute('type','submit');
  expect(container.textContent).not.toMatch(/\d{12}/); // Approved design contains no government identifiers.
 });
 it('reopening reads the persisted ON state and hides the route from an unauthorized principal',async()=>{
  mocks.policy={allowDuplicatedNric:true,revision:'fixture'};mocks.allowed=true;
  render(await PeopleGeneralPage({searchParams:Promise.resolve({})}));
  expect(screen.getByRole('switch')).toBeChecked();expect(screen.getByText('Current setting: ON')).toBeInTheDocument();
  mocks.allowed=false;await expect(PeopleGeneralPage({searchParams:Promise.resolve({})})).rejects.toThrow('redirect:/');
 });
});
