import {describe,it,expect,vi} from 'vitest';
import {render,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import viMessages from '../messages/vi.json';
import {ArchitectureWorkspaceClient} from '../app/admin/job-architecture/workspace';
import type {ArchitectureWorkspace} from '../packs/job-architecture/owner';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/admin/job-architecture/actions',()=>({architectureAction:vi.fn(async()=>({saved:true}))}));
const companyId='11111111-1111-4111-8111-111111111111';
const workspace=():ArchitectureWorkspace=>({employeeGradeCoverage:true,catalogue:{revision:0,catalogue:{nodes:[],ladder:[]}},companies:[{id:companyId,name:'Company',canPropose:true,canCheck:false}],positions:[],businessUnits:[],publications:[],suggestions:[],suggestionMetrics:[],employees:[],proposals:[],outliers:[],grades:[],global:{canPropose:true,canProposeCatalogue:true,canCheck:false,canConfigure:false},sourceDigest:'a'.repeat(64)});
const locales={en,ms,zh,th,ta,vi:viMessages};
function mount(tab:'ladder'|'catalogue'|'positions'|'outliers',locale:keyof typeof locales='en',w=workspace()){return render(<NextIntlClientProvider locale={locale} messages={locales[locale]} onError={error=>{throw error;}}><ArchitectureWorkspaceClient w={w} tab={tab} companyId={companyId} people={[]} actorId={companyId} adviceReviewed={false}/></NextIntlClientProvider>);}
describe('architecture observable workspace',()=>{
 it.each(Object.keys(locales) as (keyof typeof locales)[])('renders every tab with complete messages in %s',locale=>{for(const tab of ['ladder','catalogue','positions','outliers'] as const){const screen=mount(tab,locale);expect(screen.container.querySelector('form')).toBeTruthy();expect(screen.container.textContent).not.toContain('jobArchitecture.');screen.unmount();}});
 it('keeps future tracks visibly inactive and AI gated pending disclosure review',async()=>{const screen=mount('ladder');await userEvent.click(screen.getByText(en.jobArchitecture.futureTrack));expect(screen.getByText(/H3 ·/)).toHaveTextContent(en.jobArchitecture.notInUse);expect(screen.getByRole('status')).toHaveTextContent(en.jobArchitecture.advicePending);expect(screen.getByRole('button',{name:en.jobArchitecture.requestAdvice})).toBeDisabled();expect(screen.queryByRole('option',{name:'H3'})).toBeNull();});
 it('adds an editable catalogue record with business fields and a reason, without exposing JSON editors',async()=>{const screen=mount('catalogue');await userEvent.click(screen.getByRole('button',{name:en.jobArchitecture.addRecord}));const record=screen.getByRole('group',{name:en.jobArchitecture.newRecord});expect(within(record).getByLabelText(en.jobArchitecture.code)).toBeVisible();await userEvent.type(within(record).getByLabelText(en.jobArchitecture.name),'Finance');expect(screen.container.querySelector('textarea[name="payload"]')).toBeNull();expect(screen.getByLabelText(en.jobArchitecture.reason,{exact:false})).toBeRequired();});
});

it('shows scoped distribution counts and resets the register page when filtering by issue type',async()=>{
 const w=workspace();w.outliers=Array.from({length:51},(_,i):ArchitectureWorkspace['outliers'][number]=>{const type=i===50?'statutory_h':'unmapped_position',id='issue-'+i;return {id,fingerprint:id,company_ids:[companyId],detail:{fingerprint:id,type,companyIds:[companyId],recordIds:[],migrationOnly:i===50},state:'open',owner_id:null,due_on:null,resolution:null,revision:1,description:'',proposed_fix:'',manual:true,source_id:`FIXTURE-${i+1}`,resolved_by:null,checked_by:null};});
 const screen=mount('outliers','en',w);expect(screen.queryByText('FIXTURE-51')).toBeNull();await userEvent.click(screen.getByRole('button',{name:en.jobArchitecture.next}));expect(screen.getByText('FIXTURE-51')).toBeInTheDocument();const filter=screen.getByRole('button',{name:new RegExp(en.jobArchitecture.outlierTypes.statutory_h)});await userEvent.click(filter);expect(filter).toHaveAttribute('aria-pressed','true');expect(screen.getByText('FIXTURE-51')).toBeInTheDocument();expect(screen.queryByRole('button',{name:en.jobArchitecture.next})).toBeNull();
});

it('captures the actual populated outlier panel at desktop and phone widths on hosted Chrome',async()=>{
 if(!process.env.AIHR_FOCUSED_EVIDENCE_DIR)return;
 const w=workspace();w.companies[0].name='Example Manufacturing';const other='22222222-2222-4222-8222-222222222222';w.companies.push({id:other,name:'Example Services',canPropose:true,canCheck:false});
 const fixtureRows=[{type:'employee_grade',company:companyId,state:'open',description:'Employee and position grades differ. Confirm the work scope before proposing a dated change.',fix:'Check the approved mapping and prepare a dated movement.'},{type:'statutory_h',company:companyId,state:'partial',description:'Licensed production role remains at JG H for the current ladder.',fix:'Retain the current grade and review during future-track migration.'},{type:'unmapped_position',company:other,state:'new',description:'The position has no approved job unit mapping.',fix:'Compare the position scope with the approved catalogue.'}] as const;
 w.outliers=fixtureRows.map((o,i)=>{const id=`EXAMPLE-${i+1}`;return {id,fingerprint:id,company_ids:[o.company],detail:{fingerprint:id,type:o.type,companyIds:[o.company],recordIds:[],migrationOnly:o.type==='statutory_h'},state:o.state,owner_id:null,due_on:null,resolution:null,revision:1,description:o.description,proposed_fix:o.fix,manual:true,source_id:id,resolved_by:null,checked_by:null};});
 const view=render(<NextIntlClientProvider locale="en" messages={en} onError={error=>{throw error;}}><ArchitectureWorkspaceClient w={w} tab="outliers" people={[]} actorId={companyId} adviceReviewed={false}/></NextIntlClientProvider>);
 const summary=view.getAllByText(en.jobArchitecture.outlierTypes.employee_grade).find(node=>node.closest('summary'))?.closest('summary');if(!summary)throw new Error('Expected the real register record');await userEvent.click(summary);expect(view.getByText(fixtureRows[0].description)).toBeVisible();
 const {captureAiReviewScreenshots,aiReviewDomHtml}=await import('./helpers/ai-review-screenshots');await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','job-architecture-outliers','real scoped ArchitectureWorkspaceClient, fictional records, no authenticated server journey');
},120_000);
