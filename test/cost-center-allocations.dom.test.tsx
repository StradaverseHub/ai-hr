import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {CostCenterAllocations} from '../components/personnel/cost-center-allocations';
import type {EmploymentCostAllocationView} from '../core/employment-cost-allocations';
const ports=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn(),read:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/(app)/admin/personnel/[employmentId]/cost-allocation-actions',()=>({readCostAllocationsAction:ports.read,previewCostAllocationsAction:ports.preview,saveCostAllocationsAction:ports.save}));
const value:EmploymentCostAllocationView={employmentId:'employment',companyId:'company',effectiveDate:'2026-01-01',revision:3,current:null,rows:[],choices:[{id:'a',code:'A',label:'Operations',displayLabel:'Operations'},{id:'b',code:'B',label:'Finance',displayLabel:'Finance'}],total:0,canEdit:true,history:[],needsReplacement:false};
const show=()=>render(<NextIntlClientProvider locale="en" messages={en}><CostCenterAllocations value={value}/></NextIntlClientProvider>);
async function confirmPreview(){
 const button=await screen.findByRole('button',{name:'Confirm and save'});
 // A visible preview can precede the async preview transition settling. Act only when confirmation is actionable.
 await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
 fireEvent.click(button);
}

beforeEach(()=>{vi.clearAllMocks();ports.preview.mockImplementation(async input=>({ok:true,value:{...input,total:5000,digest:'d'.repeat(64)}}));ports.save.mockResolvedValue({ok:true});ports.read.mockResolvedValue({...value,revision:4});});afterEach(cleanup);
it('shows an unset split and unallocated remainder, validates totals and previews the complete replacement',async()=>{
 show();expect(screen.getByText('Unallocated: 100.00%')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Add cost center'}));fireEvent.change(screen.getByLabelText('Cost Center 1'),{target:{value:'a'}});fireEvent.change(screen.getByLabelText('Allocation (%) 1'),{target:{value:'100.01'}});expect(screen.getByRole('alert').textContent).toContain('100');expect(screen.getByRole('button',{name:'Preview changes'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Allocation (%) 1'),{target:{value:'50.00'}});fireEvent.click(screen.getByRole('button',{name:'Preview changes'}));await screen.findByRole('heading',{name:'Review the complete replacement set'});expect(ports.save).not.toHaveBeenCalled();await confirmPreview();await waitFor(()=>expect(ports.save).toHaveBeenCalledWith({employmentId:'employment',effectiveDate:'2026-01-01',expectedRevision:3,operation:'replace',rows:[{costCenterId:'a',percentage:'50.00'}]},'d'.repeat(64)));expect(ports.refresh).toHaveBeenCalledOnce();
});
it('requires an explicit clear confirmation and never writes when the confirmation is cancelled',async()=>{
 show();fireEvent.click(screen.getByRole('button',{name:'Preview changes'}));await screen.findByRole('button',{name:'Confirm and save'});await confirmPreview();await screen.findByRole('alertdialog');expect(ports.save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(ports.save).not.toHaveBeenCalled();
});

it('shows the shared date control and formatted history/preview while retaining the ISO date for owner actions',async()=>{
 const historical:EmploymentCostAllocationView={...value,history:[{id:'prior-set',revision:2,effectiveDate:'2025-12-01',validTo:null,companyId:'company',operation:'clear',source:'manual',superseded:false,rows:[],createdAt:'2025-12-01T00:00:00.000Z'}]};
 const {container}=render(<NextIntlClientProvider locale="en" messages={en}><CostCenterAllocations value={historical}/></NextIntlClientProvider>);
 const input=container.querySelector('input[name="effectiveDate"]') as HTMLInputElement;
 expect(input.closest('[data-date-field]')).not.toBeNull();
 expect(input.value).toBe('2026-01-01');
 expect(screen.getByText('01-Jan-2026')).toBeTruthy();
 expect(container.textContent).toContain('01-Dec-2025');
 expect(container.textContent).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
 fireEvent.click(screen.getByRole('button',{name:'Preview changes'}));
 await screen.findByRole('button',{name:'Confirm and save'});
 expect(ports.preview).toHaveBeenCalledWith(expect.objectContaining({effectiveDate:'2026-01-01'}));
 expect(container.textContent).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
 expect(ports.save).not.toHaveBeenCalled();
});
