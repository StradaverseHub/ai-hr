import {afterEach,expect,it,vi} from 'vitest';
import {todayInKualaLumpur,timeInKualaLumpur} from '../lib/hr-date';
afterEach(()=>vi.useRealTimers());
it('reads a fresh date and time across MYT midnight after formatter initialization',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-30T15:59:59.999Z'));
 expect(todayInKualaLumpur()).toBe('2026-10-30');expect(timeInKualaLumpur()).toBe('23:59');
 vi.advanceTimersByTime(1);
 expect(todayInKualaLumpur()).toBe('2026-10-31');expect(timeInKualaLumpur()).toBe('00:00');
});
it.each([
 ['2026-12-31T16:00:00Z','2027-01-01','00:00'],
 ['2024-02-29T15:30:00Z','2024-02-29','23:30'],
 ['2024-02-29T16:00:00Z','2024-03-01','00:00'],
])('formats the supplied instant %s without retaining a previous date',(instant,date,time)=>{
 const at=new Date(instant);expect(todayInKualaLumpur(at)).toBe(date);expect(timeInKualaLumpur(at)).toBe(time);
});
