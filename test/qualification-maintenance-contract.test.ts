import {describe,it,expect} from 'vitest';
import {QualificationMaintenance as C} from '../lib/assistant-actions/qualification-maintenance-contract';
const id='11111111-1111-4111-8111-111111111111';
const fields={qualification:'Bachelor',description:null,fromYm:null,toYm:null,institute:null,major:null,graduationDate:null,result:null,isHighest:false};
const add={action:C.action,contractVersion:1,employmentId:id,subjectId:id,operation:'add',qualificationId:null,fields};
describe('qualification human command boundary',()=>{
 it('keeps exact human text and disallows forged subject, operation and hidden fields',()=>{
  expect(C.Human.parse(add)).toEqual(add);
  for(const value of [{...add,subjectId:'22222222-2222-4222-8222-222222222222'},{...add,operation:'approve'},{...add,qualificationId:id},{...add,fields:{...fields,salary:'1'}},{...add,actor:'hr_admin'}])expect(C.Human.safeParse(value).success).toBe(false);
 });
 it('requires explicit existing record for update/archive and no invented archive field edits',()=>{
  expect(C.Human.safeParse({...add,operation:'archive',qualificationId:id,fields:null}).success).toBe(true);
  for(const value of [{...add,operation:'archive',qualificationId:id},{...add,operation:'update',fields:null}])expect(C.Human.safeParse(value).success).toBe(false);
 });
 it('bounds serialized Unicode before custody, including request overhead',()=>{
  const small={...add,fields:{...fields,description:'漢'.repeat(2000)}};
  expect(C.Human.safeParse(small).success).toBe(true);
  const large={...add,fields:{...fields,description:'漢'.repeat(4000),institute:'漢'.repeat(4000)}};
  expect(C.Human.safeParse(large).success).toBe(false);
 });
});
