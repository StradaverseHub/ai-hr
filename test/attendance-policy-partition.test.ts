import {describe,expect,it} from 'vitest';
import {partitionAttendancePolicyWork,type PolicyCalendarProof} from '../packs/attendance/policy-partition';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendancePolicyDayClass} from '../lib/attendance-group-policy';

const day='2024-02-29',next='2024-03-01';
const companyId='00000000-0000-4000-8000-000000000001';
function proof(date:string,dayClass:AttendancePolicyDayClass):PolicyCalendarProof{
  return {date,state:'known',companyId,dayClass,moneyDay:dayClass==='normal'||dayClass==='off'?'workday':dayClass==='rest'?'rest_day':'holiday',references:['fictional-calendar-owner:'+date+':'+dayClass]};
}
const base=()=>({sourceDate:day,companyId,periodMinutes:2880,splitAtMidnight:true,intervals:[{from:1410,to:1500}],calendar:[proof(day,'normal'),proof(next,'rest')]});
describe('one-source dated policy partition',()=>{
  it('partitions a leap-day overnight source by actual calendar date, retaining original offsets and the exact total',()=>{
    const input=base(),before=structuredClone(input),result=partitionAttendancePolicyWork(input);
    expect(result).toEqual({status:'ready',minutes:90,parts:[
      {date:day,companyId,dayClass:'normal',moneyDay:'workday',calendarReferences:input.calendar[0].state==='known'?input.calendar[0].references:[],intervals:[{from:1410,to:1440}],minutes:30},
      {date:next,companyId,dayClass:'rest',moneyDay:'rest_day',calendarReferences:input.calendar[1].state==='known'?input.calendar[1].references:[],intervals:[{from:1440,to:1500}],minutes:60},
    ]});
    expect(input).toEqual(before);
  });
  it('retains legacy source-date attribution when splitting is explicitly off',()=>{
    expect(partitionAttendancePolicyWork({...base(),splitAtMidnight:false,calendar:[proof(day,'off')]})).toMatchObject({status:'ready',minutes:90,
      parts:[{date:day,dayClass:'off',moneyDay:'workday',minutes:90,intervals:[{from:1410,to:1500}]}]});
  });
  it('unions overlapping work before splitting and neither loses nor repeats a minute',()=>{
    const result=partitionAttendancePolicyWork({...base(),intervals:[{from:1410,to:1455},{from:1440,to:1500},{from:1430,to:1460}]});
    expect(result.status).toBe('ready');if(result.status!=='ready')throw Error('Expected complete proof');
    expect(result.minutes).toBe(90);
    const covered=result.parts.flatMap(part=>part.intervals.flatMap(row=>Array.from({length:row.to-row.from},(_,offset)=>row.from+offset)));
    expect(covered).toHaveLength(90);expect(new Set(covered).size).toBe(90);
    expect(Math.min(...covered)).toBe(1410);expect(Math.max(...covered)).toBe(1499);
  });
  it.each(ATTENDANCE_POLICY_DAY_CLASSES)('retains the canonical %s classification separately from its money classification',dayClass=>{
    const result=partitionAttendancePolicyWork({...base(),intervals:[{from:60,to:120}],calendar:[proof(day,dayClass)]});
    expect(result).toMatchObject({status:'ready',parts:[{dayClass,calendarReferences:['fictional-calendar-owner:'+day+':'+dayClass]}]});
    if(result.status!=='ready')throw Error('Expected complete proof');
    expect(result.parts[0].moneyDay).toBe(dayClass==='normal'||dayClass==='off'?'workday':dayClass==='rest'?'rest_day':'holiday');
  });
  it('refuses the whole partition when the next date is unavailable rather than returning a partial first-day payment',()=>{
    expect(partitionAttendancePolicyWork({...base(),calendar:[proof(day,'normal')]})).toEqual({status:'unavailable',date:next,reason:'calendarUnavailable',parts:[]});
    expect(partitionAttendancePolicyWork({...base(),calendar:[proof(day,'normal'),{date:next,state:'unknown',reason:'holidayDesignationUnavailable'}]}))
      .toEqual({status:'unavailable',date:next,reason:'holidayDesignationUnavailable',parts:[]});
  });
  it('does not treat an ordinary holiday money label as proof of a replacement holiday',()=>{
    expect(()=>partitionAttendancePolicyWork({...base(),calendar:[{...proof(day,'normal'),state:'known',dayClass:'off',moneyDay:'holiday',references:['fictional-mismatched-proof']}]})).toThrow('classification');
    expect(()=>partitionAttendancePolicyWork({...base(),calendar:[{date:day,state:'known',companyId,dayClass:'replacementHoliday',moneyDay:'holiday',references:[]}]})).toThrow('classification');
  });
  it('refuses ambiguous calendar facts and invalid source coordinates',()=>{
    expect(()=>partitionAttendancePolicyWork({...base(),calendar:[proof(day,'normal'),proof(day,'rest')]})).toThrow('Ambiguous');
    expect(()=>partitionAttendancePolicyWork({...base(),intervals:[{from:1439,to:2881}]})).toThrow();
    expect(()=>partitionAttendancePolicyWork({...base(),intervals:[{from:60.5,to:120}]})).toThrow();
  });
  it('keeps an explicitly known empty interval set empty and creates no dated child',()=>{
    expect(partitionAttendancePolicyWork({...base(),intervals:[],calendar:[]})).toEqual({status:'ready',minutes:0,parts:[]});
  });
  it('refuses the complete source if a midnight child belongs to a different employer',()=>{
    const other=proof(next,'rest');if(other.state!=='known')throw Error('Expected explicit fixture proof');
    other.companyId='00000000-0000-4000-8000-000000000002';
    expect(partitionAttendancePolicyWork({...base(),calendar:[proof(day,'normal'),other]}))
      .toEqual({status:'unavailable',date:next,reason:'calendarUnavailable',parts:[]});
  });
});
