import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
const f=vi.hoisted(()=>({session:vi.fn(),read:vi.fn(),whole:vi.fn(),dates:vi.fn(),review:vi.fn(),refresh:vi.fn()}));
vi.mock('@/lib/scope',()=>({scopedSession:f.session}));
vi.mock('@/core/my-team',()=>({readMyTeam:f.read,decideMyTeamLeave:f.whole,decideMyTeamLeaveDates:f.dates,markMyTeamPunchReviewed:f.review}));
vi.mock('next/cache',()=>({revalidatePath:f.refresh}));
import {approveMyTeamLeaveAction,reviewMyTeamPunchAction} from '../app/manage/my-team/actions';
const company='11111111-1111-4111-8111-111111111111';
const query={view:'week',scope:'direct',companyIds:[company],anchorDate:'2026-10-01',search:'',layers:{roster:true,attendance:true,leave:true}};
function form(extra:Record<string,string>):FormData {const result=new FormData();result.set('view','week');result.set('scope','direct');for(const [key,value] of Object.entries(extra))result.set(key,value);return result;}
describe('My Team action handoff retains existing transaction-level workflow authority',()=>{
 beforeEach(()=>{vi.clearAllMocks();f.session.mockResolvedValue({s:{roles:['manager']} as SessionContext,scopeIds:[company]});f.read.mockResolvedValue({query,actionableApprovals:[{requestId:'pending',dateDecisionRequired:true,dates:[{id:'date-id',date:'2026-10-02',status:'pending'},{id:'decided-id',date:'2026-10-03',status:'approved'}]}],attention:[{kind:'missing_punch',attendanceId:'punch',fingerprint:'saved-record'}]});});
 it('hands exact pending date IDs to the owner as canonical dates with the fresh scoped query',async()=>{
  const result=await approveMyTeamLeaveAction(form({requestId:'pending',decision:'approved',dateIds:'date-id'}));
  expect(result).toEqual({ok:true});expect(f.dates).toHaveBeenCalledWith(expect.anything(),query,{leaveRequestId:'pending',decisions:[{leaveDate:'2026-10-02',decision:'approved',rejectReason:undefined}]});expect(f.whole).not.toHaveBeenCalled();
 });
 it.each(['2026-10-02','decided-id','forged-id'])('refuses a date or stale/nonpending ID %s before workflow invocation',async(dateIds)=>{
  expect(await approveMyTeamLeaveAction(form({requestId:'pending',decision:'approved',dateIds}))).toEqual({ok:false,error:'request_changed'});expect(f.dates).not.toHaveBeenCalled();expect(f.whole).not.toHaveBeenCalled();
 });
 it('requires rejection reason and retains atomic team refusal without reporting success',async()=>{
  expect(await approveMyTeamLeaveAction(form({requestId:'pending',decision:'rejected',dateIds:'date-id'}))).toEqual({ok:false,error:'invalid_query'});expect(f.dates).not.toHaveBeenCalled();
  f.dates.mockRejectedValueOnce(new Error('MY_TEAM_NOT_AUTHORIZED'));
  expect(await approveMyTeamLeaveAction(form({requestId:'pending',decision:'rejected',rejectReason:'No coverage',dateIds:'date-id'}))).toEqual({ok:false,error:'not_authorized'});expect(f.refresh).not.toHaveBeenCalled();
 });
 it('rejects a whole-request shortcut for a date-decision request',async()=>{
  expect(await approveMyTeamLeaveAction(form({requestId:'pending',decision:'approved'}))).toEqual({ok:false,error:'request_changed'});expect(f.whole).not.toHaveBeenCalled();
 });
 it('requires the current record fingerprint without writing a punch correction',async()=>{
  expect(await reviewMyTeamPunchAction(form({attendanceId:'punch',fingerprint:'outdated'}))).toEqual({ok:false,error:'review_changed'});expect(f.review).not.toHaveBeenCalled();
  expect(await reviewMyTeamPunchAction(form({attendanceId:'punch',fingerprint:'saved-record'}))).toEqual({ok:true});expect(f.review).toHaveBeenCalledWith(expect.anything(),{attendanceId:'punch',fingerprint:'saved-record'},query);
 });
 it('retains an atomic selected-context refusal when the membership changes after the initial read',async()=>{
  f.review.mockRejectedValueOnce(new Error('MY_TEAM_NOT_AUTHORIZED'));
  expect(await reviewMyTeamPunchAction(form({attendanceId:'punch',fingerprint:'saved-record'}))).toEqual({ok:false,error:'not_authorized'});
  expect(f.review).toHaveBeenCalledWith(expect.anything(),{attendanceId:'punch',fingerprint:'saved-record'},query);
  expect(f.refresh).not.toHaveBeenCalled();
 });
 it('blocks an employee or delegated approver at the page-role boundary',async()=>{
  f.session.mockResolvedValue({s:{roles:['employee']} as SessionContext,scopeIds:[company]});
  expect(await approveMyTeamLeaveAction(form({requestId:'pending',decision:'approved',dateIds:'date-id'}))).toEqual({ok:false,error:'not_authorized'});expect(f.read).not.toHaveBeenCalled();
 });
});
