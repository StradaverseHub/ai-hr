import {describe,expect,it} from 'vitest';
import {personalHolidayContext,type PersonalReplacementHoliday} from '../lib/personal-holiday-context';
import {todayInKualaLumpur} from '../lib/hr-date';
const day=todayInKualaLumpur(),nextDate=new Date(`${day}T12:00:00Z`);nextDate.setUTCDate(nextDate.getUTCDate()+1);const next=nextDate.toISOString().slice(0,10);
const labels={original:'Original holiday',replacement:'Replacement date',review:'Needs review'};
const replacement:PersonalReplacementHoliday={sourceName:'Fictional original PH',sourceDate:day,replacementDate:next,status:'allocated',coverageReason:null};
describe('one personal context for Calendar and List',()=>{
 it('preserves the original and its retained replacement link on both dates',()=>{expect(personalHolidayContext(day,[{date:day,name:'Fictional original PH'}],[replacement],labels)).toEqual(['Original holiday: Fictional original PH',`Replacement date: ${next} · Fictional original PH (${day})`]);expect(personalHolidayContext(next,[],[replacement],labels)).toEqual([`Replacement date: ${next} · Fictional original PH (${day})`]);});
 it('does not drop an original holiday when another replacement shares that date',()=>{expect(personalHolidayContext(next,[{date:next,name:'Another fictional PH'}],[replacement],labels)).toEqual(['Original holiday: Another fictional PH',`Replacement date: ${next} · Fictional original PH (${day})`]);});
 it('shows refused coverage as review context without representing the retained date as a valid replacement',()=>{expect(personalHolidayContext(next,[],[{...replacement,coverageReason:'assignment_company_changed'}],labels)).toEqual([`Needs review: Fictional original PH (${day})`]);expect(personalHolidayContext(day,[],[{...replacement,replacementDate:null,status:'review'}],labels)).toEqual([`Needs review: Fictional original PH (${day})`]);});
 it('keeps unrelated dates empty and removes duplicate display lines',()=>{const outside=new Date(`${next}T12:00:00Z`);outside.setUTCDate(outside.getUTCDate()+1);expect(personalHolidayContext(outside.toISOString().slice(0,10),[],[replacement],labels)).toEqual([]);expect(personalHolidayContext(next,[],[replacement,replacement],labels)).toHaveLength(1);});
});
