// Lane M3: Probation configuration and HR Automation screens drawn like the approved prototype. These pin the prototype
// structure (cards, headings, columns, chips, rows) while the existing commands stay wired. Server actions are mocked;
// their authority is covered by the DB tests. Fictional data.
import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {DEFAULT_PROBATION_CONFIG,PROBATION_SETTINGS_FIELD_DEFAULTS} from '../lib/probation-model';
import {DEFAULT_PROBATION_FORM,type ProbationForm} from '../lib/probation-form';
import {PROBATION_SCOPED_FIELDS} from '../lib/probation-settings-scope';
import type {ProbationSettings,ProbationSettingsScopeView,ProbationAdministrationOptions} from '../packs/probation/service';

const m=vi.hoisted(()=>({refresh:vi.fn(),saveScope:vi.fn(),saveRouting:vi.fn(),saveEmail:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh,push:vi.fn()})}));
vi.mock('next/link',async()=>{const React=await import('react');return {default:({prefetch:_prefetch,...props}:Record<string,unknown>)=>React.createElement('a',props,props.children as React.ReactNode)};});
vi.mock('../app/lifecycle/probation/actions',()=>({saveSettingsScope:m.saveScope,retireCompanySetting:vi.fn(),refreshCompanySettings:vi.fn()}));
vi.mock('../app/automation/actions',()=>({saveRoutingAction:m.saveRouting,saveEmailTemplateAction:m.saveEmail,searchPeopleAction:vi.fn()}));

import {SETTINGS_CARDS} from '../app/lifecycle/probation/settings/field-groups';
import {SettingsScopeEditor} from '../app/lifecycle/probation/settings-scope-editor';
import {FormFields} from '../app/lifecycle/probation/form-fields';
import {TemplatesWorkspace} from '../app/automation/templates/templates-workspace';
import {GroupsWorkspace} from '../app/automation/groups/groups-workspace';

afterEach(()=>{cleanup();vi.clearAllMocks();});
const wrap=(ui:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);
const c=messages.probationConfig,a=messages.automation;

const COMPANY='00000000-0000-4000-8000-0000000000c1',GROUP='00000000-0000-4000-8000-0000000000a1',KEY='00000000-0000-4000-8000-0000000000b1',SETTING='00000000-0000-4000-8000-0000000000d1';
const standardData:ProbationSettings={...structuredClone(DEFAULT_PROBATION_CONFIG),...PROBATION_SETTINGS_FIELD_DEFAULTS,eligibleGrades:['JG 12','JG 13'],plans:[{months:6,midpointMonths:3},{months:3,midpointMonths:null}],postingApproverGroupId:GROUP,overrides:[]} as ProbationSettings;
const version=(over:Record<string,unknown>)=>({id:'00000000-0000-4000-8000-0000000000e1',settingKey:KEY,scope:'standard',version:4,state:'published',name:'Group standard',companyIds:[],data:standardData,publishedAt:'2026-11-01T00:00:00Z',createdAt:'2026-11-01T00:00:00Z',reason:null,...over});
const view=():ProbationSettingsScopeView=>({canConfigure:true,truncated:false,members:[{companyId:COMPANY,settingKey:SETTING,settingName:'Fictional timing'}],
 groups:[{id:GROUP,name:'Fictional People Ops'}],
 companies:[{id:COMPANY,name:'Fictional Retail Sdn Bhd',settingsVersion:4,provenance:null,memberKey:SETTING,current:true,data:null}],
 standard:{settingKey:KEY,scope:'standard',name:'Group standard',latestVersion:4,latestState:'published',published:version({}),draft:null},
 companySettings:[{settingKey:SETTING,scope:'company',name:'Fictional timing',latestVersion:2,latestState:'published',published:version({settingKey:SETTING,scope:'company',version:2,name:'Fictional timing',companyIds:[COMPANY],data:{issueLeadDays:21}}),draft:null}],
} as unknown as ProbationSettingsScopeView);
const options={businessGroups:[],grades:['JG 12','JG 13','JG 14'],companies:[{id:COMPANY,name:'Fictional Retail Sdn Bhd'}],users:[],departments:[],businessUnits:[]} as ProbationAdministrationOptions;

describe('Probation settings (prototype SettingsPage)',()=>{
 it('puts every scoped field in exactly one settings card',()=>{
  const placed=SETTINGS_CARDS.flatMap(card=>[...card.fields]);
  expect([...placed].sort()).toEqual([...PROBATION_SCOPED_FIELDS].sort());
  expect(new Set(placed).size).toBe(placed.length);
 });

 it('shows the group-wide banner, the published standard as cards and the settings in use (decision 3)',()=>{
  wrap(<SettingsScopeEditor view={view()} options={options} selection={null} live={{live:1,total:1}}/>);
  const banner=screen.getByRole('note');
  expect(banner).toHaveTextContent(c.settings.bannerLead);
  expect(banner).toHaveTextContent('Live in 1 of 1 companies.');
  const cards=screen.getByRole('group',{name:c.settings.standardCards});
  expect(within(cards).getAllByRole('heading',{level:2}).map(h=>h.textContent)).toEqual([c.cards.who,c.cards.plans,c.cards.timing,c.cards.kpis,c.cards.extensions]);
  // Who gets a case: the eligible grades as chips.
  const who=within(cards).getByRole('region',{name:c.cards.who});
  expect(within(who).getAllByRole('listitem').map(li=>li.textContent)).toEqual(['JG 12','JG 13']);
  // Review plans: Probation Period → Reviews, in the prototype's words.
  const plans=within(cards).getByRole('region',{name:c.cards.plans});
  expect(within(plans).getAllByRole('columnheader').map(th=>th.textContent)).toEqual([c.settings.planPeriod,c.settings.planReviews]);
  const rows=within(plans).getAllByRole('row').slice(1).map(row=>within(row).getAllByRole('cell').map(cell=>cell.textContent));
  expect(rows).toEqual([['6 Month(s)','Part 2 at Month 3 · Part 3 on the end date'],['3 Month(s)','Part 3 on the end date only']]);
  // Timing: who approves postings resolves the group name.
  const timing=within(cards).getByRole('region',{name:c.cards.timing});
  expect(within(timing).getByText(messages.probation.settingsScope.fields.postingApproverGroupId).nextSibling).toHaveTextContent('Fictional People Ops');
  // Extensions: the fixed lengths as pills.
  expect(within(within(cards).getByRole('region',{name:c.cards.extensions})).getByText('3 months')).toBeInTheDocument();
  // Decision 3 stays visible: the group standard and the company setting that overrides one field.
  const inUse=screen.getByRole('region',{name:messages.probation.settingsScope.inUse});
  expect(within(inUse).getByText(messages.probation.settingsScope.groupStandard)).toBeInTheDocument();
  expect(within(inUse).getByText('Fictional timing')).toBeInTheDocument();
 });

 it('edits a company setting card by card, each field Inherited or Override against the standard',()=>{
  const {container}=wrap(<SettingsScopeEditor view={view()} options={options} selection={{kind:'company',settingKey:SETTING}}/>);
  expect(screen.queryByRole('group',{name:c.settings.standardCards})).not.toBeInTheDocument();
  const sections=[...container.querySelectorAll('[data-card]')].map(card=>card.getAttribute('data-card'));
  expect(sections).toEqual(SETTINGS_CARDS.map(card=>card.id));
  const timing=screen.getByRole('region',{name:c.cards.timing});
  const lead=within(timing).getByRole('radiogroup',{name:messages.probation.settingsScope.fields.issueLeadDays});
  expect(within(lead).getByRole('radio',{name:messages.probation.settingsScope.override})).toBeChecked();
  expect(within(timing).getByRole('spinbutton',{name:messages.probation.settingsScope.fields.issueLeadDays})).toHaveValue(21);
  const gate=within(timing).getByRole('radiogroup',{name:messages.probation.settingsScope.fields.kpiGate});
  expect(within(gate).getByRole('radio',{name:messages.probation.settingsScope.inherited})).toBeChecked();
  expect(within(timing).getAllByText(/^Group standard v4:/).length).toBeGreaterThan(0);
 });
});

describe('Form editor (prototype FormEditor)',()=>{
 const form=():ProbationForm=>({...structuredClone(DEFAULT_PROBATION_FORM),targetGrades:['JG 12']});
 it('assigns job grades through the multi-select with a count, and lists criteria per section with weights and guidance',()=>{
  const change=vi.fn();
  wrap(<FormFields value={form()} change={change} disabled={false} grades={['JG 12','JG 13','JG 14']}/>);
  expect(screen.getByRole('heading',{name:c.form.gradesTitle})).toBeInTheDocument();
  const picker=screen.getByRole('button',{name:`${c.form.gradesTitle}: JG 12`});
  expect(picker).toHaveTextContent('1 selected');
  fireEvent.click(picker);
  const list=screen.getByRole('group',{name:c.form.gradesTitle});
  fireEvent.click(within(list).getByRole('checkbox',{name:'JG 14'}));
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({targetGrades:['JG 12','JG 14']}));
  fireEvent.keyDown(document,{key:'Escape'});
  expect(screen.queryByRole('group',{name:c.form.gradesTitle})).not.toBeInTheDocument();
  // Criteria and weights: one table per section, prototype columns, totals against the 50% section weight.
  expect(screen.getByRole('heading',{name:c.form.criteriaTitle})).toBeInTheDocument();
  const tables=screen.getAllByRole('table');
  expect(tables).toHaveLength(2);
  for(const table of tables)expect(within(table).getAllByRole('columnheader').slice(0,3).map(th=>th.textContent)).toEqual([c.form.criterion,c.form.weight,c.form.guidance]);
  const total=(section:'role'|'principles')=>DEFAULT_PROBATION_FORM.criteria.filter(x=>x.section===section).reduce((sum,x)=>sum+x.weight,0);
  const totals=screen.getAllByText(/^Criteria total \d+% of 50%$/).map(node=>node.textContent);
  expect(totals).toEqual([`Criteria total ${total('role')}% of 50%`,`Criteria total ${total('principles')}% of 50%`]);
  const first=DEFAULT_PROBATION_FORM.criteria[0];
  expect(screen.queryByRole('textbox',{name:messages.probation.form.standard})).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button',{name:c.form.editGuidance})[0]);
  expect(screen.getByRole('textbox',{name:messages.probation.form.standard})).toHaveValue(first.standard);
  fireEvent.click(screen.getByRole('button',{name:`Add criterion to Section B`}));
  const added=change.mock.lastCall![0] as ProbationForm;
  expect(added.criteria).toHaveLength(DEFAULT_PROBATION_FORM.criteria.length+1);
  expect(added.criteria.filter(x=>x.section==='principles').at(-1)?.title).toBe('');
  // Rating scale and bands sit side by side as cards.
  expect(screen.getByRole('region',{name:c.form.scaleTitle})).toBeInTheDocument();
  expect(screen.getByRole('region',{name:c.form.bandsTitle})).toBeInTheDocument();
 });
});

describe('HR Automation templates and assignment groups (prototype TemplatesPage, GroupsPage)',()=>{
 const access={legacy:true,probation:true,contractStaff:true,any:true};
 const ROUTING='00000000-0000-4000-8000-0000000000f1';
 it('shows the go-live check, document rows with signing summary and pills, and email rows',()=>{
  wrap(<TemplatesWorkspace filter="probation" access={access} refs={{routings:[{id:ROUTING,name:'BP by business group'}],groups:[{id:GROUP,name:'Fictional People Ops'}],people:[]}}
   emails={[{template:{id:'00000000-0000-4000-8000-0000000000e2',module:'probation',name:'Review issued',active:false,subject:'Your review is open',body:'',cc:[]},revision:1,retired:false}]}
   letters={{companies:[{id:COMPANY,name:'Fictional Retail Sdn Bhd'}],company:{id:COMPANY,name:'Fictional Retail Sdn Bhd'},templates:[
    {id:'confirm',name:'Confirmation letter',state:'published',version:2,outcome:'confirm',routing:[{id:'r1',order:1,action:'review',who:{kind:'group',groupId:GROUP},owner:false},{id:'r2',order:2,action:'sign',who:{kind:'routing',routingId:ROUTING},owner:true},{id:'r3',order:3,action:'sign',who:{kind:'employee'},owner:false}]},
    {id:'extend',name:'Extension letter',state:'draft',version:1,outcome:'extend',routing:[]},
   ]}}/>);
  expect(screen.getByRole('heading',{level:1,name:a.templates.title})).toBeInTheDocument();
  expect(screen.getByRole('link',{name:a.modules.probation})).toHaveAttribute('aria-current','page');
  expect(screen.getByRole('status')).toHaveTextContent('Go-live check: 1 of 3 probation letters published.');
  const documents=screen.getByRole('region',{name:a.templates.documents});
  const rows=within(documents).getAllByRole('listitem');
  expect(within(rows[0]).getByRole('heading',{name:'Confirmation letter'})).toBeInTheDocument();
  expect(within(rows[0]).getByText('Probation · signing: Review Fictional People Ops → Sign BP by business group → Sign the employee')).toBeInTheDocument();
  expect(within(rows[0]).getByText(a.templates.letter)).toBeInTheDocument();
  expect(within(rows[0]).getByText('v2 in use')).toBeInTheDocument();
  expect(within(rows[0]).getByRole('link',{name:'Edit Confirmation letter in the letter template editor'})).toHaveAttribute('href',`/lifecycle/probation/templates?company=${COMPANY}`);
  expect(within(rows[1]).getByText('Probation · '+a.templates.signing.existing)).toBeInTheDocument();
  const emails=within(screen.getByRole('region',{name:a.templates.emails})).getAllByRole('listitem');
  expect(within(emails[0]).getByText(a.templates.turnedOff)).toBeInTheDocument();
  expect(within(emails[0]).getByRole('button',{name:'Open email template Review issued'})).toBeInTheDocument();
 });

 it('draws a card per assignment group with the routings that use it, and routing rules as cards',()=>{
  wrap(<GroupsWorkspace access={access} groups={[{id:GROUP,name:'Fictional People Ops'},{id:'00000000-0000-4000-8000-0000000000a2',name:'Fictional Facility'}]} people={[]}
   options={{businessGroups:[],companies:[],departments:[],jobTitles:[]}}
   routings={[{routing:{id:ROUTING,name:'BP by business group',rows:[{match:{},assignTo:{kind:'group',groupId:GROUP}}]},revision:1,retired:false,usedBy:[]}]}/>);
  expect(screen.getByRole('heading',{level:1,name:a.groups.title})).toBeInTheDocument();
  expect(screen.getByRole('link',{name:a.groups.editGroups})).toHaveAttribute('href','/lifecycle/v9?view=groups');
  const people=screen.getByRole('heading',{level:3,name:'Fictional People Ops'}).closest('li')!;
  expect(within(people).getByText('Used by: Routing “BP by business group”')).toBeInTheDocument();
  const facility=screen.getByRole('heading',{level:3,name:'Fictional Facility'}).closest('li')!;
  expect(within(facility).getByText('Not used by a routing')).toBeInTheDocument();
  const routing=screen.getByRole('article',{name:'BP by business group'});
  expect(routing).toHaveClass('pcg-rt-card');
  expect(within(screen.getByRole('region',{name:a.groups.routings})).getByRole('button',{name:a.groups.newRouting})).toBeInTheDocument();
 });
});
