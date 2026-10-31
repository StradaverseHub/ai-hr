import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
const save=vi.hoisted(()=>vi.fn());
vi.mock('../app/(app)/letters/fields/actions',()=>({saveField:save}));
import {LetterFieldForm} from '../components/letters/field-form';
const companyId='00000000-0000-4000-8000-000000000001';
const wrap=(component:React.ReactNode)=><NextIntlClientProvider locale="en" messages={messages}>{component}</NextIntlClientProvider>;
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('offers typed mappings and cannot make canonical employee facts editable',async()=>{
 const user=userEvent.setup();render(wrap(<LetterFieldForm companyId={companyId} canUseSensitive/>));await user.selectOptions(screen.getByLabelText('Data source'),'employment.hiredOn');expect(screen.getByLabelText('Data type').textContent).toBe('Date');expect(screen.getByLabelText('Allow editing after generation')).toHaveProperty('disabled',true);
 await user.selectOptions(screen.getByLabelText('Data source'),'custom.currency');expect(screen.getByLabelText('Data type').textContent).toBe('Currency amount');expect(screen.getByLabelText('Confidential field')).toHaveProperty('checked',true);expect(screen.getByLabelText('Confidential field')).toHaveProperty('disabled',true);expect(screen.getByLabelText('Allow editing after generation')).toHaveProperty('disabled',false);
});
it('does not offer confidential sources without financial permission',()=>{
 render(wrap(<LetterFieldForm companyId={companyId} canUseSensitive={false}/>));expect(screen.queryByRole('option',{name:'Basic salary'})).toBeNull();expect(screen.queryByRole('option',{name:'Custom currency amount'})).toBeNull();expect(screen.getByLabelText('Confidential field')).toHaveProperty('disabled',true);
});
it('retains entered values after a stale mapping result',async()=>{
 save.mockResolvedValue({error:'stale'});const user=userEvent.setup();render(wrap(<LetterFieldForm companyId={companyId} canUseSensitive/>));await user.type(screen.getByLabelText('Stable field key'),'letterDate');await user.type(screen.getByLabelText('Display name'),'Letter date');await user.selectOptions(screen.getByLabelText('Data source'),'custom.date');await user.click(screen.getByRole('button',{name:'Save version'}));expect((await screen.findByRole('alert')).textContent).toBe(messages.letters.fields.errors.stale);expect(screen.getByLabelText('Stable field key')).toHaveProperty('value','letterDate');expect(screen.getByLabelText('Display name')).toHaveProperty('value','Letter date');expect(screen.getByLabelText('Data source')).toHaveProperty('value','custom.date');
});
it('keeps referenced fields active and preserves their stable key during an edit',()=>{
 render(wrap(<LetterFieldForm companyId={companyId} canUseSensitive inUse initial={{ordinal:2,active:true,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false}}}/>));expect(screen.getByLabelText('Stable field key')).toHaveProperty('readOnly',true);expect(screen.getByLabelText('Active')).toHaveProperty('disabled',true);expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="active"]')!.value).toBe('yes');expect(document.querySelector<HTMLInputElement>('input[name="expectedOrdinal"]')!.value).toBe('2');
});
