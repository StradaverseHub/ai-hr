import {useState} from 'react';
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {OffboardingSignatureContext,OffboardingSignatureFallback} from '../app/lifecycle/v9/offboarding-signature-fallback';
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

it('hides only the Offboarding letter fallback when the currently displayed version has routing, without changing stored settings',()=>{
 const template={...newV9Template('Letter',{id:'fictional-hr',name:'Fictional HR'},'fixture','2026-11-17T00:00:00Z'),module:'off' as const,hrStep:'none' as const};
 const legacy=<label>HR signature<select defaultValue={template.hrStep}><option value="none">No HR signature</option></select></label>;
 const content=(hasRouting:boolean)=><NextIntlClientProvider locale="en" messages={messages}><OffboardingSignatureContext template={template} hasRouting={hasRouting}>{legacy}</OffboardingSignatureContext></NextIntlClientProvider>;
 const ui=render(content(true));expect(screen.getByText('Signing follows the routing below.')).toBeInTheDocument();expect(screen.queryByLabelText('HR signature')).not.toBeInTheDocument();
 // A new draft with no routing can configure its fallback even if the previous published version was routed.
 ui.rerender(content(false));expect(screen.getByLabelText('HR signature')).toHaveValue('none');expect(screen.queryByText('Signing follows the routing below.')).not.toBeInTheDocument();expect(template.hrStep).toBe('none');
});
it('leaves legacy HR signature controls visible for Onboarding and non-letter templates',()=>{
 const template=newV9Template('Letter',{id:'fictional-hr',name:'Fictional HR'},'fixture','2026-11-17T00:00:00Z');
 for(const context of [{...template,module:'onb' as const},{...template,module:'off' as const,type:'Form' as const}]){render(<NextIntlClientProvider locale="en" messages={messages}><OffboardingSignatureContext template={context} hasRouting><label>HR signature<select defaultValue="after"><option value="after">HR countersigns</option></select></label></OffboardingSignatureContext></NextIntlClientProvider>);expect(screen.getByLabelText('HR signature')).toHaveValue('after');expect(screen.queryByText('Signing follows the routing below.')).not.toBeInTheDocument();cleanup();}
});
