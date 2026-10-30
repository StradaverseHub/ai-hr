import {expect,it} from 'vitest';
import {GoalApproval as C} from '../lib/assistant-actions/goal-approval-contract';
import {GoalApprovalModuleActionBrowserPacket,parseGenericModuleActionBrowserResult} from '../lib/assistant-actions/module-action-http';
const id='10000000-0000-4000-8000-000000000001',input={action:C.action,contractVersion:1,employmentId:id,subjectId:id,approve:true};
it('accepts explicit single-goal human consent only and rejects model facts',()=>{expect(C.Human.parse(input)).toEqual(input);for(const extra of [{approve:false},{rating:5},{description:'model text'},{goalIds:[id]}])expect(C.Human.safeParse({...input,...extra}).success).toBe(false);});
it('binds packet action and rejects mismatched private prepared content',()=>{expect(GoalApprovalModuleActionBrowserPacket.safeParse({action:C.action,operation:'prepare',input}).success).toBe(true);expect(()=>parseGenericModuleActionBrowserResult({action:C.action,operation:'prepare',input},{kind:'completed'})).toThrow();});
it('keeps completed receipts free of private goal descriptions and review digests',()=>{expect(C.Receipt.safeParse({kind:'approved',subjectId:id,employmentId:id,eventId:id}).success).toBe(true);expect(C.Receipt.safeParse({kind:'approved',subjectId:id,employmentId:id,eventId:id,description:'private'}).success).toBe(false);});
