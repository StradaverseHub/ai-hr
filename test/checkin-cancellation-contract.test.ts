import {expect,it} from 'vitest';
import {CheckInCancellation as C} from '../lib/assistant-actions/checkin-cancellation-contract';
import {CheckInCancellationModuleActionBrowserPacket,parseGenericModuleActionBrowserResult} from '../lib/assistant-actions/module-action-http';
const id='10000000-0000-4000-8000-000000000001',input={action:C.action,contractVersion:1,employmentId:id,subjectId:id,cancel:true};
it('accepts explicit single-check-in human consent only and rejects model facts',()=>{expect(C.Human.parse(input)).toEqual(input);for(const extra of [{cancel:false},{rating:5},{description:'model text'},{checkinIds:[id]}])expect(C.Human.safeParse({...input,...extra}).success).toBe(false);});
it('binds packet action and rejects mismatched private prepared content',()=>{expect(CheckInCancellationModuleActionBrowserPacket.safeParse({action:C.action,operation:'prepare',input}).success).toBe(true);expect(()=>parseGenericModuleActionBrowserResult({action:C.action,operation:'prepare',input},{kind:'completed'})).toThrow();});
it('keeps completed receipts free of private check-in descriptions and review digests',()=>{expect(C.Receipt.safeParse({kind:'cancelled',subjectId:id,employmentId:id,eventId:id}).success).toBe(true);expect(C.Receipt.safeParse({kind:'cancelled',subjectId:id,employmentId:id,eventId:id,description:'private'}).success).toBe(false);});
