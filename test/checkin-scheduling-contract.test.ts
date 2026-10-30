import {expect,it} from 'vitest';
import {CheckInScheduling as C} from '../lib/assistant-actions/checkin-scheduling-contract';
const id='10000000-0000-4000-8000-000000000001',base={action:C.action,contractVersion:1,employmentId:id,scheduledOn:'2026-12-15',confirmSchedule:true};
it('requires the explicit actual mounted employee/date creation intent',()=>{
 expect(C.Human.parse(base)).toEqual(base);for(const input of [{...base,confirmSchedule:false},{...base,scheduledOn:'2026-02-30'},{...base,scheduledOn:''},{...base,employmentId:'invented'}])expect(C.Human.safeParse(input).success).toBe(false);
});
it('refuses notes, caller-supplied manager, result identities and generated facts',()=>{
 for(const extra of [{notes:'not in mounted form'},{managerEmploymentId:id},{subjectId:id},{checkinId:id},{eventId:id},{createdByUserId:id},{rating:5},{generated:true}])expect(C.Human.safeParse({...base,...extra}).success).toBe(false);
});
it('keeps actual created check-in and event identities in the terminal receipt only',()=>{
 const receipt={kind:'scheduled',employmentId:id,checkinId:id,eventId:id,scheduledOn:'2026-12-15'};expect(C.Receipt.parse(receipt)).toEqual(receipt);expect(C.Receipt.safeParse({...receipt,notes:'private'}).success).toBe(false);
});
