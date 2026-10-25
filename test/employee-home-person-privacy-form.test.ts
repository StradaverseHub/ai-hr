import {describe,expect,it} from 'vitest';
import {parseHomePersonPrivacyForm,validateHomePersonPrivacyInput} from '../lib/employee-home-person-privacy';

function form(){const data=new FormData();data.set('expectedOrdinal','2');return data;}
describe('Explicit own-person celebration privacy form contract',()=>{
 it('distinguishes unticked boxes from the explicit checked value',()=>{
  const data=form();expect(parseHomePersonPrivacyForm(data)).toEqual({expectedOrdinal:2,hideBirthday:false,hideAnniversary:false});
  data.set('hideBirthday','1');expect(parseHomePersonPrivacyForm(data)).toEqual({expectedOrdinal:2,hideBirthday:true,hideAnniversary:false});
  data.set('hideAnniversary','1');expect(parseHomePersonPrivacyForm(data)).toEqual({expectedOrdinal:2,hideBirthday:true,hideAnniversary:true});
 });
 it('rejects posted identity or scope and ambiguous checkbox/version fields',()=>{
  for(const key of ['personId','userId','tenantId','employmentId','companyId','role','version']){const data=form();data.set(key,'foreign');expect(()=>parseHomePersonPrivacyForm(data)).toThrow('Invalid');}
  const duplicate=form();duplicate.append('expectedOrdinal','2');expect(()=>parseHomePersonPrivacyForm(duplicate)).toThrow('Invalid');
  for(const value of ['0','false','true','on','']){const data=form();data.set('hideBirthday',value);expect(()=>parseHomePersonPrivacyForm(data)).toThrow('Invalid');}
  const both=form();both.append('hideAnniversary','1');both.append('hideAnniversary','1');expect(()=>parseHomePersonPrivacyForm(both)).toThrow('Invalid');
  const file=form();file.set('hideBirthday',new Blob(['1']),'choice.txt');expect(()=>parseHomePersonPrivacyForm(file)).toThrow('Invalid');
 });
 it('requires a bounded integer version and actual boolean choices at the service boundary',()=>{
  for(const value of ['', '-1','1.5','1e2','2147483647','9007199254740993']){const data=form();data.set('expectedOrdinal',value);expect(()=>parseHomePersonPrivacyForm(data)).toThrow('Invalid');}
  const absent=form();absent.delete('expectedOrdinal');expect(()=>parseHomePersonPrivacyForm(absent)).toThrow('Invalid');
  for(const value of [null,[],{}, {expectedOrdinal:0,hideBirthday:'false',hideAnniversary:false},
   {expectedOrdinal:0,hideBirthday:false,hideAnniversary:false,personId:'foreign'}])expect(()=>validateHomePersonPrivacyInput(value)).toThrow('Invalid');
 });
});
