import {describe,expect,it,vi} from 'vitest';
import {render,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {JobEditor} from '../app/(app)/admin/job-descriptions/editor';
import {DEFAULT_FORM,type JobInput} from '../packs/job-descriptions/model';
import type {Masters} from '../packs/job-descriptions/service';
vi.mock('../app/(app)/admin/job-descriptions/actions',()=>({saveDraftAction:vi.fn(async()=>({error:''}))}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const companyId='11111111-1111-4111-8111-111111111111';
const reviewerId='22222222-2222-4222-8222-222222222222';
const masters:Masters={companies:[{value:companyId,label:'Fictional company'}],businessUnit:[],department:[],section:[],team:[],position:[],grade:[],family:[],location:[],employmentType:[{value:'full_time',label:'full time'}],people:[]};
const initial:JobInput={companyId,jobCode:'FIN-001',title:'Finance Analyst',owner:'HR owner',org:{employmentType:'full_time'},answers:{purpose:[{purpose:'Produce reliable reports'}],responsibilities:[{responsibility:'Reconcile ledgers'},{responsibility:'Report outcomes'}]},effectiveOn:'',reviewOn:'',reason:'',approverId:'',reviewerIds:[]};
function mount(locale:keyof typeof catalogues='en',value=initial){const messages=catalogues[locale];return render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><JobEditor initial={value} definition={DEFAULT_FORM} masters={masters} principalLabels={{[reviewerId]:'Former reviewer'}}/></NextIntlClientProvider>);}
function payload(container:HTMLElement){const form=container.querySelector('form')!;return JSON.parse(String(new FormData(form).get('payload'))) as JobInput;}
describe('linked job editor observable interactions',()=>{
 it('reorders/removes entries and preserves typed values across linked form tabs',async()=>{const user=userEvent.setup();const view=mount();const first=view.getByRole('group',{name:'Key duties and responsibilities 1'});await user.click(within(first).getByRole('button',{name:'Move down'}));expect(payload(view.container).answers.responsibilities.map(v=>v.responsibility)).toEqual(['Report outcomes','Reconcile ledgers']);await user.click(view.getByRole('button',{name:'Job Analysis'}));const analyst=view.getByLabelText('Job analyst / title');await user.type(analyst,'Fictional analyst');await user.click(view.getByRole('button',{name:'Job Description'}));const moved=view.getByRole('group',{name:'Key duties and responsibilities 2'});await user.click(within(moved).getByRole('button',{name:'Remove'}));expect(payload(view.container).answers.responsibilities).toEqual([{responsibility:'Report outcomes'}]);expect(payload(view.container).answers.analysisDetails[0].analyst).toBe('Fictional analyst');});
 it('lets HR remove an unavailable hidden reviewer assignment instead of trapping the draft',async()=>{const user=userEvent.setup();const view=mount('en',{...initial,reviewerIds:[reviewerId]});const checkbox=view.getByRole('checkbox',{name:'Former reviewer (no longer eligible; remove or replace)'});expect(checkbox).toBeChecked();await user.click(checkbox);expect(payload(view.container).reviewerIds).toEqual([]);expect(checkbox).toBeDisabled();});
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders each linked form and standard choice caption without missing messages in %s',async locale=>{const user=userEvent.setup();const messages=catalogues[locale];const t=createTranslator({locale,messages,namespace:'jobDescriptions',onError:error=>{throw error;}});const view=mount(locale);expect(view.getByRole('option',{name:t('employmentTypes.full_time')})).toBeInTheDocument();for(const tab of ['analysis','description','specification','quality'] as const){await user.click(view.getByRole('button',{name:t(tab)}));expect(view.container.textContent).not.toContain('MISSING_MESSAGE');expect(view.container.textContent).not.toContain('FORMATTING_ERROR');}expect(view.getByRole('checkbox',{name:t('fields.quality.sources')})).toBeInTheDocument();});
});
it('keeps oversize files from reaching the native multipart action transport',async()=>{
 const {AttachmentFileInput}=await import('../app/(app)/admin/job-descriptions/attachment-file-input');const user=userEvent.setup();const view=render(<NextIntlClientProvider locale="en" messages={en}><form aria-label="Supporting upload"><label>Evidence file<AttachmentFileInput/></label></form></NextIntlClientProvider>);const file=new File([new Uint8Array(2097153)],'large.txt',{type:'text/plain'});const control=view.getByLabelText('Evidence file');await user.upload(control,file);expect(control).toBeInvalid();expect(view.getByRole('alert')).toHaveTextContent('2 MB');
});
