import {beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {homeQuickActionHref,homeSummaryHref,validateEmployeeHomeSummary} from '../lib/employee-home-summary';
import {todayInKualaLumpur} from '../lib/hr-date';
const state=vi.hoisted(()=>({subject:vi.fn(),config:vi.fn(),tasks:vi.fn(),enabled:vi.fn(),leave:vi.fn(),holidays:vi.fn(),replacement:vi.fn(),payroll:vi.fn(),types:vi.fn(),claims:vi.fn(),profile:vi.fn()}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,read:(tx:unknown)=>unknown)=>read({})}));
vi.mock('../core/employee-home',()=>({requireOwnHomeSubject:state.subject}));
vi.mock('../core/employee-home-configuration',()=>({readOwnEmployeeHomeConfiguration:state.config}));
vi.mock('../core/employee-home-tasks',()=>({readEmployeeHomeTasks:state.tasks}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:state.enabled}));
vi.mock('../core/read',()=>({listEligibleLeaveTypesFor:state.types}));
vi.mock('../packs/leave/service',()=>({nextApprovedLeavePresenceTx:state.leave}));
vi.mock('../packs/payroll/service',()=>({readOwnPayrollHomeMetadata:state.payroll}));
vi.mock('../packs/claims/service',()=>({ownClaimFormAvailable:state.claims}));
vi.mock('../core/profile-edit-policy',()=>({readProfilePresentationPolicy:state.profile}));
vi.mock('../core/holidays',()=>({originalHolidayCalendarFor:state.holidays}));
vi.mock('../core/holiday-replacement-read',()=>({replacementHolidayCalendarProjectionsTx:state.replacement}));
import {readEmployeeHomeSummary} from '../core/employee-home-summary';
const ctx={tenantId:'tenant',userId:'login',personId:'person',roles:['employee']} as Parameters<typeof readEmployeeHomeSummary>[0];
const today=todayInKualaLumpur(),offset=(days:number)=>new Date(Date.parse(today+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const read=()=>readEmployeeHomeSummary(ctx,'own','en','Replacement holiday');
beforeEach(()=>{
 vi.clearAllMocks();state.subject.mockResolvedValue({employmentId:'own'});state.config.mockResolvedValue({configuration:defaultEmployeeHomeConfiguration()});state.enabled.mockReturnValue(true);
 state.tasks.mockResolvedValue({total:0,overdue:0});state.leave.mockResolvedValue(null);state.holidays.mockResolvedValue([]);state.replacement.mockResolvedValue([]);
 state.payroll.mockResolvedValue({payslips:[],nextPayment:null});state.types.mockResolvedValue([]);state.claims.mockResolvedValue(false);state.profile.mockResolvedValue({editable:new Set()});
});
describe('Own Home deterministic summary and current action capability',()=>{
 it('renders the complete owner count for a queue exceeding ten thousand',async()=>{
  state.tasks.mockResolvedValue({total:20000,overdue:0});const result=await read();
  expect(validateEmployeeHomeSummary(result,'own')).toEqual(result);
  expect(result.items[0]).toMatchObject({key:'tasks',message:'Tasks waiting for you: 20,000.'});expect(result.calm).toBeNull();
 });
 it('only renders a calm sentence after all actual owners succeed, with honest disabled actions',async()=>{
  const result=await read();expect(validateEmployeeHomeSummary(result,'own')).toEqual(result);expect(result.items).toEqual([]);expect(result.calm).toBe('Nothing needs your attention today.');
  expect(result.quickActions).toEqual([{key:'leave',reason:'notConfigured'},{key:'claim',reason:'notConfigured'},{key:'payslip',reason:'noPayslip'},{key:'profile',reason:'detailsLocked'}]);
 });
 it('orders actual urgent work before reminders/good news, caps four and excludes private owner context',async()=>{
  state.tasks.mockResolvedValue({total:2,overdue:1,items:[{subjectName:'private peer'}]});state.leave.mockResolvedValue({requestId:'leave-1',date:offset(2),reason:'private medical'});
  state.holidays.mockResolvedValue([{id:'holiday-1',date:offset(3),name:'Fictional holiday',tentative:false,active:true}]);
  state.payroll.mockResolvedValue({payslips:[{id:'published',period:today.slice(0,7),amount:'private salary'}],nextPayment:{date:offset(4),amount:'private salary'}});
  state.types.mockResolvedValue([{id:'eligible'}]);state.claims.mockResolvedValue(true);state.profile.mockResolvedValue({editable:new Set(['person.firstName'])});
  const result=await read();expect(result.items).toHaveLength(4);expect(result.items[0]).toMatchObject({key:'tasks',message:'Tasks waiting for you: 2.'});expect(result.calm).toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/private|medical|amount|subjectName/);expect(result.quickActions.every(row=>row.reason===null)).toBe(true);
  expect(state.payroll).toHaveBeenCalledWith(ctx,'own');expect(state.claims).toHaveBeenCalledWith(ctx,'own');
 });
 it('does not invent a calm day when HR disabled the templates for existing facts',async()=>{
  const configuration=defaultEmployeeHomeConfiguration();configuration.templates.find(row=>row.key==='tasksPending')!.enabled=false;state.config.mockResolvedValue({configuration});state.tasks.mockResolvedValue({total:1,overdue:0});
  expect(await read()).toMatchObject({items:[],calm:null});
 });
 it('places one pending action before a payday reminder without inventing an overdue deadline',async()=>{
  state.tasks.mockResolvedValue({total:1,overdue:0});state.payroll.mockResolvedValue({payslips:[],nextPayment:{date:offset(1)}});
  const result=await read();expect(result.items.map(row=>row.key)).toEqual(['tasks','payday']);expect(result.items[0].message).toBe('Tasks waiting for you: 1.');
  expect(result.items[0].message).not.toMatch(/overdue|urgent|due today/i);
 });
 it('keeps distant/tentative facts out of near-term reminders and uses a retained replacement date',async()=>{
  state.leave.mockResolvedValue({requestId:'distant',date:offset(8)});state.payroll.mockResolvedValue({payslips:[],nextPayment:{date:offset(8)}});
  state.holidays.mockResolvedValue([{id:'tentative',date:today,name:'Tentative only',tentative:true,active:true}]);state.replacement.mockResolvedValue([{id:'retained',replacementDate:offset(2),sourceDate:'private source'}]);
  const result=await read();expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({key:'replacement:retained',destination:'calendar'});expect(result.items[0].message).toContain('Replacement holiday');
 });
 it('never converts an owner failure into an empty or calm response',async()=>{
  state.tasks.mockRejectedValue(Error('owner offline'));await expect(read()).rejects.toThrow('owner offline');
 });
 it('stops before domain reads for an unavailable identity or inactive configuration context',async()=>{
  state.subject.mockRejectedValueOnce(Error('foreign'));await expect(read()).rejects.toThrow('foreign');expect(state.tasks).not.toHaveBeenCalled();
  state.config.mockRejectedValueOnce(Error('inactive'));await expect(read()).rejects.toThrow('inactive');expect(state.payroll).not.toHaveBeenCalled();
 });
 it('never reads disabled module owners or advertises their configured action as available',async()=>{
  state.enabled.mockReturnValue(false);const result=await read();
  for(const reader of [state.leave,state.payroll,state.claims,state.types])expect(reader).not.toHaveBeenCalled();
  expect(result.quickActions.slice(0,3).every(row=>row.reason==='moduleUnavailable')).toBe(true);
 });
 it('uses literal configured text and never creates a URL from a template',async()=>{
  state.holidays.mockResolvedValue([{id:'literal',date:today,name:'{count}<script>literal</script>',active:true,tentative:false}]);
  const result=await read();expect(result.items[0].message).toContain('{count}<script>literal</script>');expect(result.items[0].destination).toBe('calendar');
 });
 it('selects published availability, not a new/unread/bank-payment promise',async()=>{
  state.payroll.mockResolvedValue({payslips:[{id:'old-but-visible',period:'2025-01'}],nextPayment:null});const result=await read();
  expect(result.items).toEqual([{key:'payslip:old-but-visible',destination:'payslip',message:'Your payslip for 2025-01 is ready.'}]);expect(result.calm).toBeNull();
 });
 it('keeps all fixed destinations on the chosen employer and applies leave only for the quick action',()=>{
  for(const key of ['leave','claim','payslip','profile','calendar','notices'] as const){expect(new URL(homeQuickActionHref(key,'second-own'),'http://local').searchParams.get('employmentId')).toBe('second-own');}
  expect(homeSummaryHref('tasks','own')).toBeNull();expect(homeSummaryHref('leave','own')).not.toContain('apply=');expect(homeQuickActionHref('leave','own')).toContain('apply=1');
 });
 it('rejects extra private fields, arbitrary destinations, incoherent calm and duplicate transport identities',async()=>{
  const value=await read();
  for(const invalid of [{...value,salary:'private'},{...value,employmentId:'foreign'},{...value,items:[{key:'x',message:'hello',destination:'https://foreign.invalid'}]},
   {...value,quickActions:[{key:'profile',reason:null,href:'https://foreign.invalid'}]},
   {...value,items:[{key:'x',message:'hello',destination:'tasks'}]},
   {...value,quickActions:[value.quickActions[0],value.quickActions[0]]}])expect(()=>validateEmployeeHomeSummary(invalid,'own')).toThrow('unavailable');
 });
});
