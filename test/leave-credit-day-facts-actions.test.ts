/** Actual server actions and canonical owner error projection; data reads are the fixture boundary. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),admin:vi.fn(),me:vi.fn(),selfFacts:vi.fn(),hrFacts:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:m.session}));vi.mock('../lib/authz',()=>({requireAdmin:m.admin}));vi.mock('../core/read',()=>({myEmployment:m.me}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));vi.mock('next/navigation',()=>({redirect:vi.fn()}));vi.mock('next-intl/server',()=>({getTranslations:vi.fn()}));
vi.mock('../packs/leave/service',async importOriginal=>{
 const actual=await importOriginal<typeof import('../packs/leave/service')>();
 return {...actual,extendedHoursDayForEmployment:m.selfFacts,leaveCreditGrantDayFacts:m.hrFacts};
});
import {ToilNotEligibleError,leaveCreditDayFactsUnavailable} from '../packs/leave/service';
import {leaveCreditDayFactsAction} from '../app/(app)/leave/credit/actions';
import {leaveCreditGrantDayFactsAction} from '../app/(app)/admin/leave-config/leave-credit/actions';
import {todayInKualaLumpur} from '../lib/hr-date';
const ctx={tenantId:'fictional-tenant',userId:'fictional-hr'},date=todayInKualaLumpur();
const facts={kind:'rest_day',scheduleName:null,shiftCode:null,shiftName:null,attendanceRecordPresent:true,shiftStart:null,shiftEnd:null,actualClockIn:'09:00',actualClockOut:'19:01',measuredExtendedMinutes:0,approvedOtPlan:null,overtimeMinutes:300,alreadyCredited:false};
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(ctx);m.admin.mockResolvedValue(ctx);m.me.mockResolvedValue({employmentId:'server-owned-employment'});m.selfFacts.mockResolvedValue(facts);m.hrFacts.mockResolvedValue(facts);});
describe('one typed known-refusal projection across self and scoped HR actions',()=>{
 it.each(['cashConflict','stale','fractional','unavailable'] as const)('returns finite %s without private owner message from both actions',async reason=>{
  const error=new ToilNotEligibleError('Private financial row/subject must not be reflected',reason);m.selfFacts.mockRejectedValue(error);m.hrFacts.mockRejectedValue(error);
  expect(await leaveCreditDayFactsAction(date)).toEqual({state:'unavailable',reason});expect(await leaveCreditGrantDayFactsAction(date,'picked-employment')).toEqual({state:'unavailable',reason});
  expect(m.selfFacts).toHaveBeenCalledWith(ctx,'server-owned-employment',date);expect(m.hrFacts).toHaveBeenCalledWith(ctx,{employmentId:'picked-employment',workedDate:date});
 });
 it('retains canonical scope/auth denial and unknown SQL failure as rejected calls for retry',async()=>{
  const failure=Error('Synthetic storage failure');m.selfFacts.mockRejectedValue(failure);m.hrFacts.mockRejectedValue(failure);
  await expect(leaveCreditDayFactsAction(date)).rejects.toBe(failure);await expect(leaveCreditGrantDayFactsAction(date,'picked')).rejects.toBe(failure);
  const spoof=Object.assign(Error('Not a canonical owner instance'),{name:'ToilNotEligibleError',formulaReason:'cashConflict'});expect(leaveCreditDayFactsUnavailable(spoof)).toBeNull();
  m.admin.mockRejectedValue(failure);m.hrFacts.mockClear();await expect(leaveCreditGrantDayFactsAction(date,'picked')).rejects.toBe(failure);expect(m.hrFacts).not.toHaveBeenCalled();
 });
 it('does not classify module-like errors by name/message or expand the existing module contract',()=>{
  expect(leaveCreditDayFactsUnavailable(Object.assign(Error('Module removed'),{name:'ModuleNotEnabledError',moduleCode:'toil'}))).toBeNull();
 });
 it('keeps missing subject/date absence and successful explicit field projection unchanged',async()=>{
  expect(await leaveCreditDayFactsAction('invalid')).toBeNull();expect(m.selfFacts).not.toHaveBeenCalled();
  expect(await leaveCreditGrantDayFactsAction(date)).toBeNull();expect(m.hrFacts).not.toHaveBeenCalled();
  m.me.mockResolvedValue(null);expect(await leaveCreditDayFactsAction(date)).toBeNull();m.me.mockResolvedValue({employmentId:'server-owned-employment'});
  const self=await leaveCreditDayFactsAction(date),hr=await leaveCreditGrantDayFactsAction(date,'picked');expect(self).toMatchObject({kind:'rest_day',approvedOtPlan:null});expect(self).not.toHaveProperty('overtimeMinutes');expect(hr).toMatchObject({overtimeMinutes:300,alreadyCredited:false});
 });
});
