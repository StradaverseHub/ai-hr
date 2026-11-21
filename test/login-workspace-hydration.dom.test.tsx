import {useState} from 'react';
import {renderToString} from 'react-dom/server';
import {hydrateRoot,type Root} from 'react-dom/client';
import {act,fireEvent} from '@testing-library/react';
import {expect,it} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import {LoginWorkspaceStep} from '../app/login/workspace-step';
import en from '../messages/en.json';
import editorial from '../messages/login-editorial/en.json';
it('keeps SSR controls inert until their state/handlers hydrate, then continues with the typed workspace',async()=>{
 function Workspace(){
  const [organization,setOrganization]=useState('perf-a'),[continued,setContinued]=useState(false);
  return <NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={{...en,loginEditorial:editorial}}>
   {continued?<input name="username" aria-label="Username" data-workspace={organization}/>:<LoginWorkspaceStep organization={organization} onChange={setOrganization} onContinue={()=>setContinued(true)} focusOnMount/>}
  </NextIntlClientProvider>;
 }
 const host=document.createElement('div');document.body.append(host);host.innerHTML=renderToString(<Workspace/>);
 let root:Root|undefined;
 try{
  expect(host.querySelector('input[name="organization"]')).toBeDisabled();
  expect(host.querySelector('button[type="submit"]')).toBeDisabled();
  expect(host.querySelector('form')).toHaveAttribute('aria-busy','true');
  await act(async()=>{root=hydrateRoot(host,<Workspace/>);});
  const workspace=host.querySelector('input[name="organization"]')!;
  expect(workspace).toBeEnabled();expect(workspace).toHaveFocus();
  expect(host.querySelector('form')).toHaveAttribute('aria-busy','false');
  fireEvent.change(workspace,{target:{value:'  perf-b  '}});
  fireEvent.click(host.querySelector('button[type="submit"]')!);
  expect(host.querySelector('input[name="username"]')).toBeVisible();
  expect(host.querySelector('input[name="username"]')).toHaveAttribute('data-workspace','perf-b');
 }finally{await act(async()=>root?.unmount());host.remove();}
});
