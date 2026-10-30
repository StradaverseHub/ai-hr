import { useState } from 'react';
import { expect,it } from 'vitest';
import { fireEvent,render,screen,within } from '@testing-library/react';
import { OnboardingPageAccess } from '../components/onboarding-page-access';
import { defaultConfig } from '../lib/onboarding-model';
function Editor(){const initial=defaultConfig('owner');initial.groups=[{id:'team',name:'Fictional team',members:['member'],limit:0}];const [config,setConfig]=useState(initial);return <><OnboardingPageAccess config={config} change={update=>setConfig(old=>{const next=structuredClone(old);update(next);return next;})}/><output data-testid="config">{JSON.stringify(config.access)}</output></>;}
it('keeps page preset selection and request-record groups independent',()=>{
 render(<Editor/>);const page=screen.getByRole('region',{name:'New Joiners page access'}),records=screen.getByRole('region',{name:'Request record access'});
 fireEvent.click(within(page).getByRole('button',{name:'Fictional team (1)'}));
 expect(within(page).getByRole('combobox',{name:'Section preset for Fictional team'})).toHaveValue('fulfil');
 expect(within(records).getByRole('button',{name:'Fictional team (1)'})).toHaveAttribute('aria-pressed','false');
 fireEvent.change(within(page).getByRole('combobox',{name:'Section preset for Fictional team'}),{target:{value:'approver'}});
 let access=JSON.parse(screen.getByTestId('config').textContent!);expect(access.joinerSections.team).toEqual({preset:'approver'});expect(access.recordGroups).toBeUndefined();
 fireEvent.click(within(records).getByRole('button',{name:'Fictional team (1)'}));access=JSON.parse(screen.getByTestId('config').textContent!);expect(access.recordGroups).toEqual(['team']);expect(access.joinerViewGroups).toEqual(['team']);
 fireEvent.change(within(page).getByRole('combobox',{name:'Section preset for Fictional team'}),{target:{value:'custom'}});
 expect(within(page).getByRole('combobox',{name:'Case details for Fictional team'})).toHaveValue('hidden');expect(within(page).getByRole('combobox',{name:'Case actions for Fictional team'})).toHaveValue('none');
});
