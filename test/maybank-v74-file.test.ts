import {describe,it,expect} from 'vitest';
import {buildMaybankV74File,maybankReceivingBank,type MaybankInput} from '../localization/my/maybank-v74-file';
const input=():MaybankInput=>({format:'salary',payer:{name:'FICTIONAL COMPANY',corporateId:'TESTCORP',account:'123456789012',employerReference:'123456789',registrationNo:'123456789012',settings:{version:'7.4',hashMode:'not-required',zakatClassification:'1'},contactName:'FICTIONAL CONTACT',contactPhone:'0312345678',stateCode:'14'},paymentDate:'2026-11-08',periodKey:'2026-11',tapeId:7,testFile:false,reference:'PAYROLL',rows:[{key:'TEST001',name:'FICTIONAL PAYEE',employeeCode:'TEST001',bank:'Maybank',account:'123456789012',identity:'900101011234',resident:'resident',citizen:true,epfNumber:'12345678',amountCents:123456,employeeCents:11000,employerCents:13000,wageCents:100000}]});
const rows=(p:MaybankInput)=>buildMaybankV74File(p).content.trimEnd().split('\r\n').map(row=>row.split('|'));
describe('strict Maybank2E-RC V7.4 fictional payment cases',()=>{
 it('writes all domestic empty columns and independent field values with exact cents',()=>{
  const p=input(),[h,d,f]=rows(p);expect([h.length,d.length,f.length]).toEqual([29,337,29]);
  expect(h.slice(0,3)).toEqual(['00','TESTCORP','261108007']);
  expect(d.slice(0,5)).toEqual(['01','IT','Staff Payroll','','08112026']);
  expect(d[7]).toBe('261108007-000001');expect(d.slice(10,16)).toEqual(['MYR','1234.56','Y','MYR','123456789012','123456789012']);
  expect(d[18]).toBe('Y');expect(d[19]).toBe('FICTIONAL PAYEE');expect(d[109]).toBe('01');
  expect(f.slice(0,4)).toEqual(['99','1','1234.56','']);expect(d.at(-1)).toBe('');expect(buildMaybankV74File(p).content.endsWith('\r\n')).toBe(true);
 });
 it('routes an interbank record and preserves its unique reference',()=>{
  const p=input();p.rows.push({...p.rows[0],key:'TEST002',bank:'CIMB Bank',account:'1234567890',amountCents:44});const file=rows(p);
  expect(file[2][1]).toBe('IG');expect(file[2][36]).toBe('CIBBMYKL');expect(file[2][7]).toBe('261108007-000002');expect(file[3][2]).toBe('1235.00');
 });
 it('uses documented Islamic account distinctions without collapsing the receiving BIC',()=>{
  expect(maybankReceivingBank('Maybank','151234567890').code).toBe('MBISMYKL');expect(maybankReceivingBank('CIMB','1612345678').code).toBe('CTBBMYKL');
  expect(()=>maybankReceivingBank('Maybank Islamic','123456789012')).toThrow(/unambiguously/);
 });
 it('keeps statutory layouts separate and writes whole-RM EPF into the right fields',()=>{
  const p=input();p.format='kwsp';const[h,d,f]=rows(p);expect([h.length,d.length,f.length]).toEqual([42,136,28]);
  expect(h.slice(0,12)).toEqual(['00','Statutory Body','5','02','123456789','FICTIONAL COMPANY','112026','123456789012','08112026','','A','14']);
  expect(d[7]).toBe('12345678');expect(d.slice(11,17)).toEqual(['110.00','130.00','','TEST001','1000.00','TEST001']);expect(f.slice(0,8)).toEqual(['99','110.00','130.00','1','1','1','240.00','']);
  p.rows[0].employeeCents=11001;expect(()=>buildMaybankV74File(p)).toThrow(/cannot be rounded/);
 });
 it('preserves the separate V7.4 Lindung 24 Jam leg and reconciles all SOCSO contributions',()=>{
  const p=input();p.format='socso';p.payer.employerReference='123456789012';p.rows[0]={...p.rows[0],employeeCents:495,employerCents:1735,skbbkCents:1200};const[h,d,f]=rows(p);
  expect(h[2]).toBe('1');expect(d[11]).toBe('4.95');expect(d[12]).toBe('17.35');expect(d[39]).toBe('12.00');expect(f.slice(1,8)).toEqual(['16.95','17.35','1','1','1','34.30','']);
 });
 it('keeps the full LHDN tax group/reference, separate PCB/CP38 and wife code',()=>{
  const p=input();p.format='lhdn';p.payer.employerReference='E1234567890';p.rows[0]={...p.rows[0],taxNumber:'SG12345678900',wifeCode:'0',pcbCents:1234,cp38Cents:567};const[h,d,f]=rows(p);
  expect(h[2]).toBe('4');expect(h[9]).toBe('2');expect(d[7]).toBe('SG12345678900');expect(d.slice(11,15)).toEqual(['12.34','5.67','0','TEST001']);expect(f[6]).toBe('18.01');
 });
 it.each([['01','18'],['02','12'],['03','21'],['04','17'],['05','7'],['06','14'],['07','16'],['08','15'],['09','11'],['10','8'],['11','13'],['12','20'],['14','6']])('supports V7.4 Zakat state %s with its body code', (state,body)=>{
  const p=input();p.format='zakat';p.payer.stateCode=state;p.payer.employerReference='ZAKAT-TEST';const[h,d,f]=rows(p);expect(h[2]).toBe(body);expect(d[20]).toBe('1');expect(d[12]).toBe('');expect(f[6]).toBe('1234.56');
 });
 it('uses Sarawak’s supported salary deduction classification and refuses a mismatched one',()=>{const p=input();p.format='zakat';p.payer.stateCode='13';expect(()=>buildMaybankV74File(p)).toThrow(/classification/);p.payer.settings.zakatClassification='5';expect(rows(p)[0][2]).toBe('19');});
 it.each(['unconfirmed','required'])('refuses an unavailable or unconfirmed hash arrangement %s',hashMode=>{const p=input();p.payer.settings.hashMode=hashMode as 'unconfirmed';expect(()=>buildMaybankV74File(p)).toThrow();});
 it.each(['PIPE|VALUE','LINE\nBREAK','名字','QUOTED"NAME'])('refuses unsafe/unsupported characters without truncation: %s',name=>{const p=input();p.rows[0].name=name;expect(()=>buildMaybankV74File(p)).toThrow();});
 it('requires payee banking residency independently of tax/citizenship and bounds every amount',()=>{
  const p=input();p.rows[0].resident=null;expect(()=>buildMaybankV74File(p)).toThrow(/banking residency/);p.rows[0].resident='resident';p.rows[0].amountCents=1.5;expect(()=>buildMaybankV74File(p)).toThrow(/saved amount/);
 });
});
