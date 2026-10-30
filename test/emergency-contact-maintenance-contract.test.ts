import {describe,it,expect} from 'vitest';
import {EmergencyContactMaintenance as C} from '../lib/assistant-actions/emergency-contact-maintenance-contract';
const employmentId='11111111-1111-4111-8111-111111111111',personId='22222222-2222-4222-8222-222222222222';
const fields={fullName:'Human contact name',relationship:null,mobilePhone:null,homePhone:null,address:null,remarks:null,priority:'other'};
const add={action:C.action,contractVersion:1,employmentId,subjectId:personId,operation:'add',contactId:null,fields};
describe('Emergency contact human boundary',()=>{
 it('preserves exact human text and a distinct person subject; refuses undeclared fields, authority and operations',()=>{expect(C.Human.parse(add)).toEqual(add);for(const input of [{...add,actor:'hr_admin'},{...add,operation:'approve'},{...add,fields:{...fields,salary:'1'}},{...add,fields:{...fields,priority:'boss'}}])expect(C.Human.safeParse(input).success).toBe(false);});
 it('requires an existing contact for update/archive and excludes archive field edits',()=>{expect(C.Human.safeParse({...add,operation:'archive',contactId:employmentId,fields:null}).success).toBe(true);for(const input of [{...add,operation:'archive'},{...add,operation:'update',fields:null},{...add,contactId:employmentId}])expect(C.Human.safeParse(input).success).toBe(false);});
 it('bounds actual serialized Unicode before encrypted custody',()=>{expect(C.Human.safeParse({...add,fields:{...fields,address:'漢'.repeat(2000)}}).success).toBe(true);expect(C.Human.safeParse({...add,fields:{...fields,address:'漢'.repeat(4000),remarks:'漢'.repeat(4000)}}).success).toBe(false);});
});
