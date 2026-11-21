/** Maybank2E-RC V7.4 pipe-delimited domestic/statutory payment writer.
 * Private reporter specification: feedback 566a19dc, revision 6 Aug 2026, pp7–22/32–40/50.
 * No guessed hash: the initial file leaves it blank; an explicit hashing hold refuses generation.
 */
import {BankPaymentFileError} from '../country-pack';
import {isCalendarDate} from '../../lib/calendar-date';
import {myBankByKey,MY_BANKS} from '../../lib/my-banks';
import {tryBnmCodeForBankName} from './bank-files/bnm-codes';
import {maybankPaymentSettingsSchema,type MaybankPaymentSettings} from '../../lib/maybank-payment-settings';
import type {OcbcFormat,OcbcRow} from './ocbc-file';
export type MaybankRow=OcbcRow&{resident?:'resident'|'non_resident'|null;citizen?:boolean;socialSecurityNumber?:string;skbbkCents?:number};
export type MaybankInput={format:OcbcFormat;payer:{name:string;corporateId:string;account:string;employerReference:string;registrationNo?:string;settings:MaybankPaymentSettings;contactName:string;contactPhone:string;stateCode:string};paymentDate:string;periodKey:string;tapeId:number;testFile:boolean;reference:string;rows:MaybankRow[]};
export class MaybankFileError extends BankPaymentFileError{constructor(message:string){super(message);this.name='MaybankFileError';}}
const fail=(message:string):never=>{throw new MaybankFileError(message);};
const text=(raw:string|undefined,max:number,label:string,required=true)=>{const value=(raw??'').trim();if(required&&!value||value.length>max||!/^[\x20-\x7e]*$/.test(value)||/[|"\r\n]/.test(value))fail(`${label}: use ${required?'a nonempty value with ':''}at most ${max} printable English characters, without pipes, quotes or line breaks.`);return value;};
const digits=(raw:string|undefined,max:number,label:string,exact?:number)=>{const value=text(raw,max,label);if(!/^\d+$/.test(value)||exact!==undefined&&value.length!==exact)fail(`${label}: enter ${exact??'at most '+max} digits.`);return value;};
function amount(value:number|undefined,label:string,max=15){if(!Number.isSafeInteger(value)||value!<0)fail(`${label}: a nonnegative saved amount in cents is required.`);const n=value!;const result=`${Math.floor(n/100)}.${String(n%100).padStart(2,'0')}`;if(result.length>max)fail(`${label}: amount exceeds the bank field.`);return result;}
const sum=(values:number[])=>{const n=values.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(n))fail('Payment total exceeds supported precision.');return n;};
const record=(count:number,fields:Record<number,string|undefined>)=>{const columns=Array<string>(count).fill('');for(const [index,value]of Object.entries(fields))if(value!==undefined)columns[Number(index)-1]=value;return columns.join('|');};
// Receiving BICs verified against the bank-published directory, 8 Nov 2026:
// https://www.rhbgroup.com/myreflex/premium/articles/article/bulk_csv_file/index.html (BICSWIFT appendix).
// The supplied Maybank writer uses these only as receiving SWIFT identities, never RHB layout/amount/hash rules.
const bic:Record<string,string>={maybank:'MBBEMYKL',cimb:'CIBBMYKL',public_bank:'PBBEMYKL',rhb:'RHBBMYKL',ambank:'ARBKMYKL',alliance_bank:'MFBBMYKL',affin_bank:'PHBMMYKL',hong_leong_bank:'HLBBMYKL',hsbc_bank:'HBMBMYKL',ocbc_bank:'OCBCMYKL',uob:'UOVBMYKL',standard_chartered:'SCBLMYKX',citibank:'CITIMYKL',bank_islam:'BIMBMYKL',bank_muamalat:'BMMBMYKL',bank_rakyat:'BKRMMYKL',bsn:'BSNAMYK1',agrobank:'AGOBMYKL',al_rajhi:'RJHIMYKL',icbc:'ICBKMYKL',deutsche_bank:'DEUTMYKL',jp_morgan:'CHASMYKX',kuwait_finance_house:'KFHOMYKL',mizuho:'MHCBMYKA',mufg:'BOTKMYKX',sumitomo_mitsui:'SMBCMYKL',bnp_paribas:'BNPAMYKL',bank_of_america:'BOFAMY2X'};
// The shared legacy bank picker collapses some Islamic variants. Never route their known account
// prefixes to the conventional BIC. Prefix distinctions: JANM 2025 Kod Bank, verified 8 Nov 2026.
export function maybankReceivingBank(bank:string,account:string){
 const found=myBankByKey(bank)??MY_BANKS.find(value=>value.code===tryBnmCodeForBankName(bank));if(!found||!bic[found.key])return fail('Receiving bank has no verified Maybank routing. Correct the personnel bank record.');
 const key=found.key;let code=bic[key];
 if(key==='maybank'&&/^(15|16|55|56)/.test(account))code='MBISMYKL';
 if(key==='cimb'&&account.length===10&&/^[0-9][6-9]/.test(account))code='CTBBMYKL';
 if(key==='public_bank'&&/^(38|39|47|48|49|68|69)/.test(account))code='PIBEMYK1';
 if(key==='hong_leong_bank'&&account.length===11&&account.slice(3,5)==='51')code='HLIBMYKL';
 if(key==='hsbc_bank'&&account.startsWith('022'))code='HMABMYKL';
 if(key==='rhb'&&/^(15|16|26|56)/.test(account))code='RHBAMYKL';
 if(/islamic|al[- ]amin|amanah|saadiq/i.test(bank)&&code===bic[key]&& !['bank_islam','bank_muamalat','al_rajhi'].includes(key))fail('The recorded Islamic bank and account cannot be resolved unambiguously. Correct its bank identity before exporting.');
 return {code,internal:key==='maybank'};
}
export function buildMaybankV74File(p:MaybankInput){
 const settings=maybankPaymentSettingsSchema.parse(p.payer.settings);
 if(settings.hashMode!=='not-required')fail('This account is on hold for hashing details. Obtain the bank-issued formula before generating its payment file.');
 if(p.testFile)fail('The supplied Maybank V7.4 layout has no test-file indicator.');
 if(!isCalendarDate(p.paymentDate)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.periodKey))fail('Choose a valid payment date and contribution month.');
 if(!Number.isInteger(p.tapeId)||p.tapeId<1||p.tapeId>999)fail('A unique bank file sequence is required.');
 if(!p.rows.length||p.rows.length>99999)fail('Choose between 1 and 99999 payable records.');
 const [y,m,d]=p.paymentDate.split('-'),date=d+m+y,period=p.periodKey.slice(5)+p.periodKey.slice(0,4);
 const corporate=text(p.payer.corporateId,30,'Maybank corporate ID'),payer=text(p.payer.name,50,'Bank-registered employer name');
 const batch=`${y.slice(2)}${m}${d}${String(p.tapeId).padStart(3,'0')}`; // nine characters, unique under the immutable company/date sequence.
 const reference=text(p.reference,16,'Payment reference',false),seen=new Set<string>();
 for(const row of p.rows){if(seen.has(row.key))fail('Duplicate payment record identity.');seen.add(row.key);}
 let lines:string[],totalCents:number;
 if(p.format==='salary'){
  const debit=digits(p.payer.account,15,'Maybank debit account',12);
  const details=p.rows.map((row,index)=>{
   const account=digits(row.account,35,`${row.key} receiving account`),route=maybankReceivingBank(row.bank??'',account);
   if(!row.resident)fail(`${row.key}: record the payee banking residency in Personnel → Bank Information.`);
   const name=text(row.name,120,`${row.key} account-holder name`),identity=text(row.identity,20,`${row.key} payee ID`,false);
   if(identity&&!/^[A-Za-z0-9]+$/.test(identity))fail(`${row.key}: payee identification must be alphanumeric.`);
   if(row.amountCents<=0)fail(`${row.key}: salary payment must be positive.`);
   const value=amount(row.amountCents,row.key,16);if(value.length>16)fail(`${row.key}: salary exceeds the bank amount field.`);
   return record(337,{1:'01',2:route.internal?'IT':'IG',3:'Staff Payroll',5:date,8:`${batch}-${String(index+1).padStart(6,'0')}`,9:reference,10:reference,11:'MYR',12:value,13:'Y',14:'MYR',15:debit,16:account,19:row.resident==='resident'?'Y':'N',20:name.slice(0,40),21:name.slice(40,80),22:name.slice(80,120),...(/^\d{12}$/.test(identity)?{25:identity}:identity?{28:identity}:{}),37:route.internal?'':route.code,102:reference,103:reference,110:'01'});
  });
  totalCents=sum(p.rows.map(row=>row.amountCents));
  lines=[record(29,{1:'00',2:corporate,3:batch}),...details,record(29,{1:'99',2:String(details.length),3:amount(totalCents,'Total salary')})];
 }else{
  const epf=p.format==='kwsp',socso=p.format==='socso',lhdn=p.format==='lhdn',zakat=p.format==='zakat';
  const zakatBodies:Record<string,string>={'14':'6','05':'7','10':'8','09':'11','02':'12','11':'13','06':'14','08':'15','07':'16','04':'17','01':'18','13':'19','12':'20','03':'21'};
  const state=p.payer.stateCode,body=epf?'5':socso?'1':lhdn?'4':zakatBodies[state];
  if(!body)fail('Choose a supported Maybank Zakat state in company bank settings.');
  if(zakat&&(state==='13'?!['4','5'].includes(settings.zakatClassification):!['02','07','08'].includes(state)&&settings.zakatClassification==='3'||['4','5'].includes(settings.zakatClassification)))fail('The selected Zakat classification is not supported by this state in V7.4.');
  if(epf&&!/^(0[1-9]|1[0-4])$/.test(state))fail('Choose a two-digit Maybank EPF company state code.');
  const employer=text(p.payer.employerReference,zakat?20:13,'Employer statutory payment reference');
  if(epf&&!/^\d{9}$/.test(employer)||socso&&!/^[A-Za-z0-9]{12}$/.test(employer)||lhdn&&!/^[A-Za-z]\d{10}$/.test(employer))fail('Employer statutory reference does not match the Maybank V7.4 category format.');
  const ees:number[]=[],ers:number[]=[],eeCounts:number[]=[],erCounts:number[]=[];
  const details=p.rows.map(row=>{
   const ee=epf||socso?row.employeeCents??0:lhdn?row.pcbCents??0:row.amountCents,er=epf||socso?row.employerCents??0:lhdn?row.cp38Cents??0:0,skbbk=socso?row.skbbkCents??0:0;
   if(epf&&(ee%100||er%100||(row.wageCents??0)%100))fail(`${row.key}: Maybank EPF requires whole-RM recorded contributions and wages; payroll amounts cannot be rounded for export.`);
   const employee=ee+skbbk;ees.push(employee);ers.push(er);eeCounts.push(employee>0?1:0);erCounts.push(er>0?1:0);
   const identity=text(row.identity,15,`${row.key} identity`,false),passport=text(row.passport,15,`${row.key} passport`,false),oldId=text(row.oldIdentity,15,`${row.key} old IC`,false);
   if(socso?!row.socialSecurityNumber&&!identity:zakat?!identity&&!oldId:!identity&&!oldId&&!passport)fail(`${row.key}: complete the statutory identity required by Maybank.`);
   if((epf||lhdn)&&typeof row.citizen!=='boolean')fail(`${row.key}: record employee citizenship for the statutory file.`);
   const country=(epf||lhdn)&&!row.citizen?text(row.countryCode,2,`${row.key} passport country`):'';
   if(country&&!/^[A-Z]{2}$/.test(country))fail(`${row.key}: passport country must use a two-letter code.`);
   const employeeRef=epf?digits(row.epfNumber,8,`${row.key} EPF member number`,8):lhdn?text(row.taxNumber,13,`${row.key} tax number`):socso?text(row.socialSecurityNumber,19,`${row.key} social security number`,false):'';
   if(lhdn&&!/^[A-Za-z]{2}\d{11}$/.test(employeeRef))fail(`${row.key}: LHDN employee reference must include its two-letter group and eleven digits.`);
   if(lhdn&&!/^[01]$/.test(row.wifeCode??''))fail(`${row.key}: a valid LHDN Wife Code is required.`);
   return record(136,{1:'01',2:text(row.key,30,'Employee reference'),5:text(row.name,80,`${row.key} employee name`),...((epf||lhdn)?{6:row.citizen?'Y':'N',7:country}:{}),8:employeeRef,9:identity,...(!socso?{10:oldId}:{}),...(!socso&&!zakat?{11:passport}:{}),12:socso&&ee===0?'':amount(ee,row.key),13:zakat?'':socso||epf||er>0?amount(er,row.key):'',...(lhdn?{14:row.wifeCode!}:{}),...((epf||lhdn)?{15:text(row.employeeCode,20,`${row.key} staff number`)}:{}),...(epf?{16:amount(row.wageCents,`${row.key} EPFable wages`),17:text(row.employeeCode,20,`${row.key} identifying initials`)}:{}),...(zakat?{21:settings.zakatClassification}:{}),...(socso&&skbbk>0?{40:amount(skbbk,`${row.key} Lindung 24 Jam`)}:{})});
  });
  const ee=sum(ees),er=sum(ers);totalCents=sum([ee,er]);
  lines=[record(42,{1:'00',2:'Statutory Body',3:body,4:'02',5:employer,6:payer,7:period,8:digits(p.payer.account,20,'Maybank debit account',12),9:date,...(lhdn?{10:'2'}:{}),...(epf?{11:'A',12:state,17:text(p.payer.contactName,40,'EPF contact person'),18:text(p.payer.contactPhone,20,'EPF contact phone')}:{}),13:reference,14:reference,21:batch,22:corporate,...(zakat&&!['14','05','10'].includes(state)?{23:text(p.payer.registrationNo,18,'Business or society registration number')}:{} )}),...details,record(28,{1:'99',2:amount(ee,'Total employee contribution'),3:amount(er,'Total employer contribution'),4:String(sum(eeCounts)),5:String(sum(erCounts)),6:String(details.length),7:amount(totalCents,'Total statutory payment')})];
 }
 const content=lines.join('\r\n')+'\r\n';if(Buffer.byteLength(content,'ascii')>10*1024*1024)fail('Maybank accepts a maximum 10 MB payment file. Narrow the selection.');
 return {content,totalCents,recordCount:p.rows.length,filename:`M2E_RC74_${p.format.toUpperCase()}_${y}${m}${d}_${String(p.tapeId).padStart(3,'0')}.txt`};
}
