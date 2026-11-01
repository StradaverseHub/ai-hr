import {expect,it} from 'vitest';
import {actionFormData} from '../scripts/performance/action-form';
it('keeps referenced form data ahead of the React root model through actual multipart serialization',async()=>{
 const fields={'0':JSON.stringify([{error:null},'$K1']),'_1_incurredOn':'2026-10-30','_1_amount':'1','_1_description':'Fictional claim','_1_employmentId':'fixture-subject'};
 // Object enumeration places integer0 first; that is the real replay regression.
 expect(Object.keys(fields)[0]).toBe('0');
 const body=actionFormData(fields,['_1_incurredOn','_1_amount','_1_description','0']);
 const decoded=await new Request('https://example.invalid/claims',{method:'POST',body}).formData();
 expect([...decoded.keys()]).toEqual(['_1_incurredOn','_1_amount','_1_description','_1_employmentId','0']);
 expect(decoded.get('_1_incurredOn')).toBe('2026-10-30');
 expect(JSON.parse(String(decoded.get('0')))).toEqual([{error:null},'$K1']);
});
it('preserves delete action field order and does not invent model fields for ordinary forms',()=>{
 expect([...actionFormData({'0':'["$K1"]','_1_id':'draft'},['_1_id','0']).keys()]).toEqual(['_1_id','0']);
 expect([...actionFormData({name:'Fictional',amount:2}).entries()]).toEqual([['name','Fictional'],['amount','2']]);
});
