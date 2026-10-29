/** OCBC Velocity layouts supplied with feedback 9eff8939. Pure, strict, ASCII/CRLF writers.
 * Layouts are distinct from government-portal files. No truncation, guessed routing or rounding of money.
 * LHDN/Zakat remain unavailable: their mandatory hash algorithm is absent from the supplied documents.
 */
import { myBankByKey, MY_BANKS } from '../../lib/my-banks';
import { tryBnmCodeForBankName } from './bank-files/bnm-codes';
export type OcbcFormat = 'salary'|'kwsp'|'socso'|'lhdn'|'zakat';
export class OcbcFileError extends Error { constructor(message:string){super(message);this.name='OcbcFileError';} }
export type OcbcSettings={contactName:string;contactPhone:string;stateCode:string;requireIdCheck:boolean};
export type OcbcPayer={name:string;corporateId:string;account:string;branch:string;settings:OcbcSettings;employerReference?:string};
export type OcbcRow={key:string;name:string;employeeCode?:string;account?:string;bank?:string;identity?:string;epfNumber?:string;employeeCents?:number;employerCents?:number;wageCents?:number;amountCents:number};
export type OcbcInput={format:OcbcFormat;payer:OcbcPayer;paymentDate:string;periodKey:string;tapeId:number;testFile:boolean;reference:string;rows:OcbcRow[]};
// IBG Product Offering and Account Structure, supplied edition 27 October 2023.
// Current/savings lengths only. Loan/card rails are not payroll accounts. RBS is explicitly terminated.
const routes:Record<string,{id:string;lengths:number[]}>= {
 maybank:{id:'100002270',lengths:[12]},cimb:{id:'100002050',lengths:[10,14]},public_bank:{id:'100002335',lengths:[10]},rhb:{id:'100002186',lengths:[14]},
 ambank:{id:'100002089',lengths:[13]},alliance_bank:{id:'100002128',lengths:[15]},affin_bank:{id:'100002322',lengths:[12]},hong_leong_bank:{id:'100002241',lengths:[11,13]},
 hsbc_bank:{id:'100002225',lengths:[12,13,14,15,17]},ocbc_bank:{id:'100002296',lengths:[10,11,12,13,14,15,16,17]},uob:{id:'100002267',lengths:[7,9,10,11,12,13,14,17]},
 standard_chartered:{id:'100002144',lengths:Array.from({length:13},(_,i)=>i+5)},citibank:{id:'100002173',lengths:Array.from({length:8},(_,i)=>i+9)},bank_islam:{id:'100002458',lengths:[14]},
 bank_muamalat:{id:'100003415',lengths:[14]},bank_rakyat:{id:'100016020',lengths:[10,12]},bsn:{id:'100016017',lengths:[16]},agrobank:{id:'100033061',lengths:[16]},al_rajhi:{id:'100003509',lengths:[15]},
 icbc:{id:'100002597',lengths:[13,17]},deutsche_bank:{id:'100002199',lengths:Array.from({length:8},(_,i)=>i+10)},jp_morgan:{id:'100002157',lengths:Array.from({length:8},(_,i)=>i+10)},
 kuwait_finance_house:{id:'100003460',lengths:[12]},mizuho:{id:'100002610',lengths:[10]},mufg:{id:'100002102',lengths:[6]},sumitomo_mitsui:{id:'100002623',lengths:[8]},bnp_paribas:{id:'100002636',lengths:Array.from({length:11},(_,i)=>i+6)},bank_of_america:{id:'100002076',lengths:Array.from({length:13},(_,i)=>i+5)},
};
export function ocbcRouting(bank:string,account:string):{routingId:string;account:string}{
 const found=myBankByKey(bank)??MY_BANKS.find(value=>value.code===tryBnmCodeForBankName(bank));
 const rule=found&&routes[found.key];
 if(!rule)throw new OcbcFileError('Receiving bank has no supported OCBC IBG routing. Correct the employee bank record.');
 let digits=account.trim();
 if(!/^\d+$/.test(digits))throw new OcbcFileError('Receiving account must contain digits only.');
 // ICBC's supplied footnote explicitly strips the 01 prefix from a 19-digit actual account.
 if(found.key==='icbc'&&digits.length===19&&digits.startsWith('01'))digits=digits.slice(2);
 if(!rule.lengths.includes(digits.length))throw new OcbcFileError('Receiving account length does not match the supplied IBG account structure.');
 return {routingId:rule.id,account:digits};
}
function text(value:string|undefined,length:number,label:string,required=true){const v=(value??'').trim();if((required&&!v)||!/^[\x20-\x7e]*$/.test(v)||v.length>length)throw new OcbcFileError(`${label}: enter ${required?'a nonempty ':''}printable English value of at most ${length} characters.`);return v.padEnd(length,' ');}
function numeric(value:string|number|undefined,length:number,label:string){const v=String(value??'').trim();if(!/^\d+$/.test(v)||v.length>length)throw new OcbcFileError(`${label}: enter at most ${length} digits.`);return v.padStart(length,'0');}
function money(value:number|undefined,length:number,label:string){if(!Number.isSafeInteger(value)||value!<0)throw new OcbcFileError(`${label}: the saved amount must be nonnegative with two decimal places.`);return numeric(value,length,label);}
function total(values:number[]){const n=values.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(n))throw new OcbcFileError('The file total exceeds supported precision.');return n;}
function record(){const chars=Array(480).fill(' ');return {put(start:number,width:number,value:string){if(value.length!==width||start<1||start+width-1>480)throw new Error('OCBC layout field width mismatch');chars.splice(start-1,width,...value);},value:()=>chars.join('')};}
function dates(p:OcbcInput){if(!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(p.paymentDate)||!Number.isFinite(Date.parse(p.paymentDate+'T00:00:00Z'))||new Date(p.paymentDate+'T00:00:00Z').toISOString().slice(0,10)!==p.paymentDate)throw new OcbcFileError('Choose a valid payment date.');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.periodKey))throw new OcbcFileError('Choose a valid contribution period.');const[y,m,d]=p.paymentDate.split('-');return {valueDate:d+m+y,period:p.periodKey.slice(5,7)+p.periodKey.slice(0,4)};}
export function buildOcbcFile(p:OcbcInput){
 if(p.format==='lhdn'||p.format==='zakat')throw new OcbcFileError('OCBC confirmation of the mandatory Hash Total is required before this format can be downloaded.');
 const {valueDate,period}=dates(p);
 if(!Number.isInteger(p.tapeId)||p.tapeId<1||p.tapeId>999)throw new OcbcFileError('Tape ID must be between 001 and 999.');
 if(!p.rows.length)throw new OcbcFileError('There are no payable records for the selected run or period.');
 if(p.rows.length>99999)throw new OcbcFileError('Narrow the selection to fewer than 100000 records.');
 const payer=p.payer,h=record();h.put(1,2,'01');h.put(31,30,text(payer.name,30,'Company bank-registered name'));h.put(61,20,numeric(payer.account,20,'Company debit account'));h.put(81,1,'D');h.put(83,8,valueDate);
 if(p.format==='salary'){
  h.put(3,3,numeric(p.tapeId,3,'Tape ID'));h.put(6,5,numeric(payer.branch,5,'OCBC branch'));h.put(11,20,text(payer.corporateId,20,'OCBC CIF'));h.put(82,1,'N');h.put(131,16,text(p.reference,16,'Customer reference',false));
 }else{
  h.put(23,3,numeric(p.tapeId,3,'Tape ID'));h.put(26,5,numeric(payer.branch,5,'OCBC branch'));h.put(91,10,text(p.format==='kwsp'?'KWSP':'SOCSO',10,'Application'));
  const debitMonth=Number(p.paymentDate.slice(0,4))*12+Number(p.paymentDate.slice(5,7)),contribMonth=Number(p.periodKey.slice(0,4))*12+Number(p.periodKey.slice(5,7));
  if(Math.abs(debitMonth-contribMonth)>12||p.format==='socso'&&contribMonth>debitMonth)throw new OcbcFileError('Contribution period is outside the bank’s supported payment-date window.');
  if(p.format==='kwsp'){
   h.put(3,20,text('EPF MONTHLY FORM A',20,'Description'));h.put(101,19,numeric(payer.employerReference,19,'Employer KWSP number'));h.put(120,6,period);h.put(126,3,numeric(payer.settings.stateCode,3,'State code'));h.put(129,40,text(payer.settings.contactName,40,'KWSP contact person'));h.put(169,20,numeric(payer.settings.contactPhone,20,'KWSP contact phone'));h.put(189,1,'N');h.put(190,2,'00');h.put(192,1,p.testFile?'Y':'N');h.put(193,16,text(p.reference,16,'Customer reference',false));
  }else{
   h.put(110,6,period);h.put(116,3,numeric(payer.settings.stateCode,3,'State code'));h.put(119,1,p.testFile?'Y':'N');h.put(120,16,text(p.reference,16,'Customer reference',false));h.put(136,2,'8A');h.put(158,12,text(payer.employerReference,12,'Employer SOCSO number'));
  }
 }
 const details=p.rows.map(row=>{try{
  const r=record();r.put(1,2,'02');
  if(p.format==='salary'){
   if(row.amountCents<=0)throw new OcbcFileError('Salary payment must be positive.');
   const routing=ocbcRouting(row.bank??'',row.account??'');r.put(3,20,text(routing.account,20,'Payee account'));r.put(23,17,money(row.amountCents,17,'Net salary'));r.put(40,1,'C');r.put(61,20,text(p.reference,20,'Recipient reference',false));r.put(121,9,routing.routingId);r.put(130,22,text(row.name,22,'Bank account holder name'));
   const id=(row.identity??'').trim();if(payer.settings.requireIdCheck&&!id)throw new OcbcFileError('Bank account holder identification is required for ID checking.');
   if(/^\d{12}$/.test(id))r.put(41,12,id);else if(id)r.put(152,20,text(id,20,'Bank account holder identification'));
   r.put(247,1,payer.settings.requireIdCheck?'Y':'N');
  }else if(p.format==='kwsp'){
   if((row.employeeCents??0)%100||(row.employerCents??0)%100)throw new OcbcFileError('KWSP contributions must be whole ringgit; correct the approved payroll amount rather than rounding the bank file.');
   r.put(3,19,numeric(row.epfNumber,19,'Employee KWSP number'));r.put(22,15,text(row.identity,15,'KWSP identification'));const name=text(row.name,80,'Employee name');r.put(37,40,name.slice(0,40));r.put(77,40,name.slice(40));r.put(117,20,text(row.employeeCode,20,'Employee code',false));r.put(137,17,money(row.employerCents,17,'Employer contribution'));r.put(154,17,money(row.employeeCents,17,'Employee contribution'));r.put(171,17,money(row.wageCents,17,'EPFable wages'));
  }else{
   const id=(row.identity??'').trim();if(!/^\d{1,12}$/.test(id))throw new OcbcFileError('SOCSO identification must contain at most 12 digits.');r.put(12,12,text(id,12,'SOCSO identification'));r.put(24,45,text(row.name,45,'Employee name'));r.put(102,14,money(row.amountCents,14,'SOCSO contribution'));
  }return r.value();
 }catch(error){if(error instanceof OcbcFileError)throw new OcbcFileError(`${row.key}: ${error.message}`);throw error;}});
 const trailer=record();let totalCents:number;
 if(p.format==='salary'){totalCents=total(p.rows.map(r=>r.amountCents));trailer.put(1,2,'03');trailer.put(3,6,numeric(p.rows.length,6,'Record count'));trailer.put(9,19,money(totalCents,19,'Salary total'));}
 else if(p.format==='kwsp'){const employer=total(p.rows.map(r=>r.employerCents??0)),employee=total(p.rows.map(r=>r.employeeCents??0));totalCents=total([employer,employee]);trailer.put(1,2,'99');trailer.put(3,7,numeric(p.rows.length,7,'Member count'));trailer.put(10,17,money(employer,17,'Employer total'));trailer.put(27,17,money(employee,17,'Employee total'));}
 else{totalCents=total(p.rows.map(r=>r.amountCents));trailer.put(1,2,'99');trailer.put(3,5,numeric(p.rows.length,5,'Record count'));trailer.put(8,14,money(totalCents,14,'SOCSO total'));}
 const lines=[h.value(),...details,trailer.value()],content=lines.join('\r\n')+'\r\n';
 if(Buffer.byteLength(content,'ascii')>4*1024*1024)throw new OcbcFileError('The OCBC upload exceeds the supplied 4 MB limit.');
 // Independent basic output assertion: every record must still be exactly 480 printable bytes.
 if(lines.some(line=>line.length!==480||!/^[\x20-\x7e]{480}$/.test(line)))throw new Error('OCBC output verification failed');
 return {content,recordCount:p.rows.length,totalCents,filename:`ocbc-${p.format}-${p.paymentDate}-${String(p.tapeId).padStart(3,'0')}.txt`};
}
