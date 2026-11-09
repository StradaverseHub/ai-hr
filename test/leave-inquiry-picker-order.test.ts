import {expect,it} from 'vitest';
import {sortInquiryEmployees} from '../lib/leave-inquiry';
import {matchesLeaveInquiryPicker,normalizeLeaveInquiryPicker} from '../lib/leave-inquiry-picker';
const words=['Acme','acme','Ácme','Åland','İnci','i\u0307nci','ΟΣ','Ος','Straße','STRASSE','Kelvin','Kelvin','தமிழ்','ไทย','Nguyễn','人員','😀'];
it('preserves the exact previous company/name/default-identity ordering through deep pages in six locales',()=>{
 const rows=Array.from({length:400},(_,n)=>({employmentId:String(400-n).padStart(6,'0'),name:words[n%words.length],company:words[Math.floor(n/7)%words.length]}));
 const original=structuredClone(rows);
 for(const locale of ['en','ms','ta','th','vi','zh',undefined]){
  const expected=[...rows].sort((a,b)=>a.company.localeCompare(b.company,locale,{sensitivity:'base'})||a.name.localeCompare(b.name,locale,{sensitivity:'base'})||a.employmentId.localeCompare(b.employmentId));
  const actual=sortInquiryEmployees(rows,locale);expect(actual).toEqual(expected);
  for(const offset of [0,25,100,325])expect(actual.slice(offset,offset+25)).toEqual(expected.slice(offset,offset+25));
 }
 expect(rows).toEqual(original);expect(sortInquiryEmployees([], 'invalid_locale')).toEqual([]);
});
it('retains the old exact JavaScript search semantics and refuses invalid navigation input',()=>{
 expect(matchesLeaveInquiryPicker({name:'İnci',employeeCode:null},'i')).toBe(true);
 expect(matchesLeaveInquiryPicker({name:'Straße',employeeCode:'ABC%'},'STRASSE')).toBe(false);
 expect(matchesLeaveInquiryPicker({name:'Straße',employeeCode:'ABC%'},'%')).toBe(true);
 expect(matchesLeaveInquiryPicker({name:'ΟΣ',employeeCode:null},'ος')).toBe(true);
 for(const input of [{offset:-1},{offset:Number.MAX_SAFE_INTEGER,limit:200},{limit:201},{status:'unknown'},{companyId:'unknown'},{labelMode:'labels'}])expect(()=>normalizeLeaveInquiryPicker(input as never)).toThrow();
});
