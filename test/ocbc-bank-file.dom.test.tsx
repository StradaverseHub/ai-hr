import {describe,it,expect} from 'vitest';
import {buildOcbcFile,ocbcLhdnTaxIdentity,ocbcRouting,type OcbcInput} from '../localization/my/ocbc-file';
const salary=():OcbcInput=>({format:'salary',payer:{name:'FICTIONAL COMPANY',corporateId:'A999999',account:'1234567890',branch:'701',settings:{contactName:'FICTIONAL CONTACT',contactPhone:'0312345678',stateCode:'014',requireIdCheck:true}},paymentDate:'2026-10-29',periodKey:'2026-10',tapeId:7,testFile:false,reference:'PAYROLL',rows:[{key:'TEST-ONLY',name:'FICTIONAL PERSON',bank:'Maybank',account:'123456789012',identity:'100000000001',amountCents:123456}]});
const lines=(input:OcbcInput)=>buildOcbcFile(input).content.split('\r\n').filter(Boolean);
describe('OCBC supplied bank layouts',()=>{
 it('writes independently expected GIRO header/detail/trailer positions and reconciles cents',()=>{
  const [header,detail,trailer]=lines(salary());
  expect(header.slice(0,30)).toBe('0100700701A999999             ');
  expect(header.slice(60,90)).toBe('00000000001234567890DN29102026');
  expect(detail.slice(0,40)).toBe('02123456789012        00000000000123456C');
  expect(detail.slice(120,151)).toBe('100002270FICTIONAL PERSON      ');
  expect(detail.slice(246,247)).toBe('Y');
  expect(trailer.slice(0,27)).toBe('030000010000000000000123456');
  expect([header,detail,trailer].every(value=>value.length===480)).toBe(true);
  expect(buildOcbcFile(salary()).content.endsWith('\r\n')).toBe(true);
 });
 it('sums multiple exact saved net amounts and never computes payroll',()=>{
  const p=salary();p.rows.push({...p.rows[0],key:'SECOND',amountCents:44});
  const file=buildOcbcFile(p);expect(file.totalCents).toBe(123500);expect(lines(p).at(-1)?.slice(2,27)).toBe('0000020000000000000123500');
 });
 it('writes KWSP employee, employer and wages in their different boxes',()=>{
  const p=salary();p.format='kwsp';p.testFile=true;p.payer.employerReference='12345';p.rows=[{key:'TEST-ONLY',name:'FICTIONAL PERSON',identity:'100000000001',epfNumber:'54321',employeeCode:'E-TEST',amountCents:0,employeeCents:11000,employerCents:13000,wageCents:100000}];
  const [h,d,t]=lines(p);expect(h.slice(0,30)).toBe('01EPF MONTHLY FORM A  00700701');expect(h.slice(90,128)).toBe('KWSP      0000000000000012345102026014');expect(h.slice(188,192)).toBe('N00Y');
  expect(d.slice(136,187)).toBe('000000000000130000000000000001100000000000000100000');
  expect(t.slice(0,43)).toBe('9900000010000000000001300000000000000011000');expect(t.slice(43,63)).toBe(' '.repeat(20));
  expect(buildOcbcFile(p).totalCents).toBe(24000);
 });
 it('rejects cents on KWSP contributions instead of rounding the saved payroll',()=>{
  const p=salary();p.format='kwsp';p.payer.employerReference='123';p.rows[0]={...p.rows[0],epfNumber:'123',employeeCents:10001,employerCents:20000,wageCents:100000};expect(()=>buildOcbcFile(p)).toThrow(/whole ringgit/);
 });
 it('writes SOCSO 8A with optional hash blank and the saved combined amount',()=>{
  const p=salary();p.format='socso';p.testFile=true;p.payer.employerReference='SOCSO-TEST';const [h,d,t]=lines(p);
  expect(h.slice(109,137)).toBe('102026014YPAYROLL         8A');expect(h.slice(157,169)).toBe('SOCSO-TEST  ');expect(d.slice(101,115)).toBe('00000000123456');expect(t.slice(0,21)).toBe('990000100000000123456');expect(t.slice(21,41)).toBe(' '.repeat(20));
 });
 it('projects the approved saved TIN suffix without changing or truncating the personnel Tax Number',()=>{
  const saved='IG10234567091';expect(ocbcLhdnTaxIdentity(saved)).toEqual({taxNumber:'1023456709',wifeCode:'1'});expect(saved).toBe('IG10234567091');expect(ocbcLhdnTaxIdentity('SG10234567090')).toEqual({taxNumber:'1023456709',wifeCode:'0'});
  for(const value of ['IG10234567092','','IG102345670901'])expect(()=>ocbcLhdnTaxIdentity(value)).toThrow();
 });
 it('writes LHDN PCB/CP38 counts and totals with exactly20 reserved blank hash bytes',()=>{
  const p=salary();p.format='lhdn';p.payer.employerReference='123456';p.rows[0]={...p.rows[0],taxNumber:'9876543210',wifeCode:'0',pcbCents:1234,cp38Cents:567};p.rows.push({...p.rows[0],key:'CP38 ONLY',pcbCents:0,cp38Cents:100});
  const [h,d,,t]=lines(p);expect(h.slice(90,130)).toBe('LHDN      00001234560000123456102026014N');expect(d.slice(2,25)).toBe('98765432100100000000001');expect(d.slice(119,137)).toBe('0000123400000567MY');
  expect(t.slice(0,32)).toBe('99000010000001234000020000000667');expect(t.slice(32,52)).toBe(' '.repeat(20));expect(t.slice(52)).toBe(' '.repeat(428));expect(buildOcbcFile(p).totalCents).toBe(1901);
 });
 it('writes Zakat income and exact reserved blank hash bytes without zero filling the hash',()=>{
  const p=salary();p.format='zakat';p.payer.employerReference='Z1234';p.rows[0].paymentType='PENDAPATAN';const [h,d,t]=lines(p);
  expect(h.slice(90,131)).toBe('ZAKAT     Z1234102026014NPAYROLL         ');expect(d.slice(76,103)).toBe('00000000000123456PENDAPATAN');expect(t.slice(0,26)).toBe('99000000100000000000123456');expect(t.slice(26,46)).toBe(' '.repeat(20));expect(t.slice(46)).toBe(' '.repeat(434));
 });
 it('refuses missing Wife Code, fabricated country metadata, and unsupported Zakat state',()=>{
  const p=salary();p.format='lhdn';p.payer.employerReference='123';p.rows[0].pcbCents=123;expect(()=>buildOcbcFile(p)).toThrow(/Wife Code/);p.rows[0].wifeCode='0';p.rows[0].passport='P123';expect(()=>buildOcbcFile(p)).toThrow(/country code/);p.format='zakat';p.rows[0].paymentType='PENDAPATAN';p.payer.settings.stateCode='013';expect(()=>buildOcbcFile(p)).toThrow(/014 only/);
 });
 it.each(['lhdn','zakat'] as const)('requires live indicator N for %s',format=>{const p=salary();p.format=format;p.testFile=true;expect(()=>buildOcbcFile(p)).toThrow(/indicator N/);});
 it('uses the supplied nine-digit routing, not the two-digit BNM code',()=>{expect(ocbcRouting('Maybank','123456789012')).toEqual({routingId:'100002270',account:'123456789012'});});
 it('applies the supplied ICBC prefix rule only for an actual 19-digit 01 account',()=>{expect(ocbcRouting('ICBC','0112345678901234567')).toEqual({routingId:'100002597',account:'12345678901234567'});expect(()=>ocbcRouting('ICBC','9912345678901234567')).toThrow(/length/);});
 it.each(['Royal Bank of Scotland','unknown bank'])('refuses unsupported receiving bank %s',bank=>expect(()=>ocbcRouting(bank,'123456789012')).toThrow(/routing/));
 it.each([0,-1,NaN,Infinity,1.01])('refuses invalid salary amount %s',amountCents=>{const p=salary();p.rows[0].amountCents=amountCents;expect(()=>buildOcbcFile(p)).toThrow();});
 it.each(['2026-02-30','2026-13-01','bad','2026-10-99'])('refuses invalid payment date %s',paymentDate=>{const p=salary();p.paymentDate=paymentDate;expect(()=>buildOcbcFile(p)).toThrow();});
 it('refuses identity-check requests without an ID and overlong/non-ASCII names',()=>{const p=salary();p.rows[0].identity='';expect(()=>buildOcbcFile(p)).toThrow(/identification/);p.payer.settings.requireIdCheck=false;p.rows[0].name='A'.repeat(23);expect(()=>buildOcbcFile(p)).toThrow(/22/);p.rows[0].name='名字';expect(()=>buildOcbcFile(p)).toThrow(/English/);});
 it('bounds sequence numbers and forbids advanced SOCSO months',()=>{const p=salary();p.tapeId=1000;expect(()=>buildOcbcFile(p)).toThrow(/Tape ID/);p.tapeId=1;p.format='socso';p.periodKey='2026-11';expect(()=>buildOcbcFile(p)).toThrow(/window/);});
});
