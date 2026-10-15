import { describe, expect, it } from 'vitest';
import { nextMasterScheduleAt, validateMasterSchedule } from '../lib/employee-master-schedule';
describe('Employee Master wall-time recurrence',()=>{
 it('weekly Kuala Lumpur schedule uses the selected local time',()=>{expect(nextMasterScheduleAt({frequency:'weekly',day:1,hour:9,minute:15,timezone:'Asia/Kuala_Lumpur'},new Date('2024-05-05T22:00:00Z')).toISOString()).toBe('2024-05-06T01:15:00.000Z');});
 it('clamps day 31 to the last day of February without rolling into March',()=>{expect(nextMasterScheduleAt({frequency:'monthly',day:31,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},new Date('2024-02-01T00:00:00Z')).toISOString()).toBe('2024-02-29T01:00:00.000Z');});
 it('does not schedule the repeated fall-back wall time twice',()=>{const config={frequency:'weekly' as const,day:0,hour:1,minute:30,timezone:'America/New_York'};const first=nextMasterScheduleAt(config,new Date('2024-11-03T04:00:00Z'));expect(first.toISOString()).toBe('2024-11-03T05:30:00.000Z');expect(nextMasterScheduleAt(config,first).toISOString()).toBe('2024-11-10T06:30:00.000Z');});
 it('refuses invalid zone, period day, minute and unexpected config fields',()=>{for(const extra of [{timezone:'not-a-zone'},{day:32},{minute:60},{sql:'select secret'}])expect(()=>validateMasterSchedule({frequency:'monthly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur',...extra})).toThrow();});
});
