import {useState} from 'react';
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {OffboardingSignatureFallback} from '../app/lifecycle/v9/offboarding-signature-fallback';
import {newV9Template} from '../lib/lifecycle-v9-authoring';
import type {Template} from '../lib/lifecycle-v9-model';
afterEach(cleanup);
function Harness({module='off',hasRouting=false,disabled=false}:{module?:Template['module'];hasRouting?:boolean;disabled?:boolean}){
 const [template,setTemplate]=useState<Template>(()=>({...newV9Template('Letter',{id:'fictional-hr',name:'Fictional HR'},'fixture','2026-11-17T00:00:00Z'),module}));
 return <NextIntlClientProvider locale="en" messages={messages}><OffboardingSignatureFallback template={template} hasRouting={hasRouting} disabled={disabled} onChange={value=>setTemplate(previous=>{const next={...previous};if(value)next.offboardingHrSignature=value;else delete next.offboardingHrSignature;return next;})}/><output data-testid="template">{JSON.stringify(template)}</output></NextIntlClientProvider>;
}
it('records each explicit Offboarding fallback without changing the legacy HR signature setting',()=>{
 render(<Harness/>);const select=screen.getByLabelText('Fallback HR signature');expect(select).toHaveValue('');
 expect([...select.querySelectorAll('option')].map(option=>[option.value,option.textContent])).toEqual([['','Keep existing HR signature setting'],['pbp','PBP signs before release'],['beforeEmployee','HR signs before employee'],['namedHr','Named HR signatory signs before release']]);
 for(const value of ['pbp','beforeEmployee','namedHr']){fireEvent.change(select,{target:{value}});expect(JSON.parse(screen.getByTestId('template').textContent!)).toMatchObject({module:'off',hrStep:'before',offboardingHrSignature:value});}
 fireEvent.change(select,{target:{value:''}});const restored=JSON.parse(screen.getByTestId('template').textContent!);expect(restored.hrStep).toBe('before');expect(restored).not.toHaveProperty('offboardingHrSignature');
});
it('keeps the fallback out of Onboarding and out of versions with explicit routing',()=>{
 render(<Harness module="onb"/>);expect(screen.queryByLabelText('Fallback HR signature')).not.toBeInTheDocument();cleanup();render(<Harness hasRouting/>);expect(screen.queryByLabelText('Fallback HR signature')).not.toBeInTheDocument();
});
it('keeps a published version read-only through the existing editor disabled state',()=>{render(<Harness disabled/>);expect(screen.getByLabelText('Fallback HR signature')).toBeDisabled();});
