import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {PersonnelPrivateFilterChips} from '../app/admin/personnel/private-filter-chips';
afterEach(cleanup);
it('shows each active private criterion and posts individual removal with the complete remaining set',()=>{
 const criteria={term:'PRIVATE-ID',filters:[{field:'name',operator:'contains' as const,value:'Private Name'},{field:'company',operator:'equals' as const,value:'fixture-company'}]};
 const view=render(<NextIntlClientProvider locale="en" messages={en}><PersonnelPrivateFilterChips criteria={criteria} parameters={[["search","a".repeat(43)],["sort","name"]]} labels={{term:'Employee details',name:'Full name',company:'Company'}}/></NextIntlClientProvider>);
 expect(screen.getByText(/Private Name/)).toBeVisible();const button=screen.getByRole('button',{name:'Remove Company filter'});const form=button.closest('form')!;expect(form).toHaveAttribute('method','post');expect(form).toHaveAttribute('action','/admin/personnel/search');expect(button).toHaveAttribute('name','removeField');expect(button).toHaveAttribute('value','company');expect(form.querySelector('input[name="field.name"]')).toHaveValue('Private Name');
 expect(view.container.querySelector('a[href*="PRIVATE"]')).toBeNull();expect(form.querySelector('input[name="search"]')).toBeNull();
});
