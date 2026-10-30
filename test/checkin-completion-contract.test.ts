import {expect,it} from 'vitest';
import {CheckInCompletion as C} from '../lib/assistant-actions/checkin-completion-contract';
const id='10000000-0000-4000-8000-000000000001',base={action:C.action,contractVersion:1,employmentId:id,subjectId:id,complete:true};
it('requires an explicit notes decision and separates preservation from handwritten replacement',()=>{
 expect(C.Human.parse({...base,notesMode:'preserve'})).toEqual({...base,notesMode:'preserve'});
 expect(C.Human.parse({...base,notesMode:'replace',notes:'  Human handwritten note  '})).toMatchObject({notes:'  Human handwritten note  '});
 for(const input of [{...base},{...base,notesMode:'preserve',notes:'hidden replacement'},{...base,notesMode:'replace'},{...base,notesMode:'replace',notes:' \n '},{...base,notesMode:'replace',notes:'x'.repeat(8001)}])expect(C.Human.safeParse(input).success).toBe(false);
});
it('refuses posted actors, notes snapshots, clocks, ratings and generated-field metadata',()=>{
 for(const extra of [{userId:id},{completedAt:'2026-10-30T00:00:00.000Z'},{beforeNotes:'posted'},{rating:5},{generated:true},{complete:false}])expect(C.Human.safeParse({...base,notesMode:'preserve',...extra}).success).toBe(false);
});
it('keeps completed receipts free of private before/after notes',()=>{
 const receipt={kind:'completed',subjectId:id,employmentId:id,eventId:id,completedAt:'2026-10-30T00:00:00.000Z'};
 expect(C.Receipt.parse(receipt)).toEqual(receipt);expect(C.Receipt.safeParse({...receipt,notes:'private'}).success).toBe(false);
});
