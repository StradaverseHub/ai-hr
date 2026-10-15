import {describe,it,expect} from 'vitest';
import {ownCreditRegisterQuery} from '../lib/own-credit-register-query';
describe('Personal earned-credit filters',()=>{
 it('refuses subject selection, repeated filters, impossible dates and inverted ranges',()=>{
  for(const sp of [{employee:'foreign'}, {personId:'foreign'}, {from:['2026-01-01','2026-02-01']}, {from:'2026-02-30'},{from:'2026-02-02',to:'2026-02-01'},{status:'used'}])expect(ownCreditRegisterQuery(sp).valid).toBe(false);
 });
 it('accepts each canonical status and keeps paging independent of date filters',()=>{
  for(const status of ['available','partially_used','fully_used','expired','reversed','paid_out'])expect(ownCreditRegisterQuery({status,from:'2026-02-01',to:'2026-02-28',page:'20',size:'25'})).toMatchObject({valid:true,query:{offset:500,limit:25}});
 });
});
