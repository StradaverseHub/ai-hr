/**
 * MEASUREMENT ONLY (branch claude/worker-stall-measure-20261114, never merged): shared pieces of the import-worker
 * stall-watchdog phase timings. Fictional data only.
 */
import {cpus,totalmem} from 'node:os';
import {performance} from 'node:perf_hooks';
import {BANK_IMPORT_MAX_BYTES,BANK_IMPORT_MAX_ROWS} from '../../lib/bank-import-job';
import {sectionTemplateColumns} from '../../lib/import-sections';
import {personnelColumnLabel} from '../../lib/personnel-import-contract';
import {buildPersonnelCsv} from '../../lib/personnel-csv';

export const TAG='[worker-stall-measure]';
export type Timing={label:string;seconds:number;peakRssMiB:number};
export const timings:Timing[]=[];
const mib=(n:number)=>Math.round(n/1048576);

export function hostLine(){
 const c=cpus();
 console.info(`${TAG} host: ${c.length} CPUs (${c[0]?.model??'unknown'}), ${mib(totalmem())} MiB RAM, node ${process.version}`);
}

/** Times one awaited phase and samples RSS every 200 ms while it runs (synchronous stretches are not sampled). */
export async function clock<T>(label:string,fn:()=>Promise<T>):Promise<T>{
 let peak=process.memoryUsage().rss;
 const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},200);
 const started=performance.now();
 try{return await fn();}
 finally{
  clearInterval(timer);peak=Math.max(peak,process.memoryUsage().rss);
  const seconds=(performance.now()-started)/1000;
  timings.push({label,seconds,peakRssMiB:mib(peak)});
  console.info(`${TAG} ${label}: ${seconds.toFixed(2)} s (peak RSS ~${mib(peak)} MiB)`);
 }
}

export function summary(name:string){
 console.info(`${TAG} SUMMARY ${name} ${JSON.stringify(timings.map(t=>({...t,seconds:Number(t.seconds.toFixed(2))})))}`);
}

/** Every column of the downloadable Bank & Statutory template, in template order. */
export const BANK_COLUMNS=sectionTemplateColumns('bank_statutory');
export const BANK_CAPTIONS=BANK_COLUMNS.map(column=>personnelColumnLabel(column,'employee'));

/** The value combination test/bank-statutory-import.test.ts round-trips as valid, plus the bank block. */
const FIXED:Record<string,string>={
 bank_name:'Maybank',enable_custom_holder_name:'Yes',enable_custom_holder_id:'Yes',
 epf_citizenship:'pr',epf_category:'manual_percentage',epf_employee_rate:'15',epf_employer_rate:'16',employer_bears_epf:'Yes',
 socso_category:'second',eis_category:'none',subject_to_skbbk:'Yes',employer_bears_socso:'yes',employer_bears_eis:'YES',employer_bears_skbbk:'no',
 subject_to_hrdf:'No',tax_circumstance:'spouse_working',tax_residency:'knowledge_worker',disabled_individual:'Yes',disabled_spouse:'yes',
 child_relief_mode:'auto_table',child_relief_under_18_full:'2',child_relief_study_tertiary_half:'1',employer_bears_tax:'No',
};
const NAMES=['Nurul Aisyah binti Abdullah','Tan Wei Ming','Rajesh a/l Subramaniam','Siti Hajar binti Mohd Yusof','Lim Mei Ling','Muhammad Faris bin Ismail'];

/** One fictional data row (1-based n) with every template column; `pad` lengthens the two free-text holder cells. */
export function bankRow(n:number,pad:number):string[]{
 const filler=(seed:string)=>{let s=seed;while(s.length<pad)s+=` ${NAMES[(n+s.length)%NAMES.length]}`;return s.slice(0,Math.max(pad,seed.length));};
 const values:Record<string,string>={
  ...FIXED,employee_code:`SCALE${n}`,bank_account_no:`5140${String(n).padStart(8,'0')}`,
  custom_holder_name:filler(`${NAMES[n%NAMES.length]} ${n}`),custom_holder_id:filler(`HID-${n}`),
  epf_number:`EPF${String(n).padStart(9,'0')}`,socso_number:`SOC${String(n).padStart(9,'0')}`,tax_number:`SG${String(n).padStart(10,'0')}`,
 };
 return BANK_COLUMNS.map(column=>values[column]??'');
}

/** Pad length that brings ROWS rows of the Personnel CSV to just under the 128 MiB limit (2 MiB margin). */
export function padForSizeLimit(rows=BANK_IMPORT_MAX_ROWS){
 const sample=Buffer.byteLength(buildPersonnelCsv('employee',[BANK_CAPTIONS,...Array.from({length:1000},(_,i)=>bankRow(i+1,0))]));
 const perRow=sample/1000,budget=(BANK_IMPORT_MAX_BYTES-2*1048576)/rows;
 return Math.max(0,Math.floor((budget-perRow)/2));
}

export function worstCaseCsv(rows=BANK_IMPORT_MAX_ROWS):Buffer{
 const pad=padForSizeLimit(rows);
 const data:string[][]=[BANK_CAPTIONS];
 for(let n=1;n<=rows;n++)data.push(bankRow(n,pad));
 const bytes=Buffer.from(buildPersonnelCsv('employee',data));
 console.info(`${TAG} CSV: ${rows} rows x ${BANK_COLUMNS.length} columns, holder pad ${pad}, ${(bytes.length/1048576).toFixed(1)} MiB (limit ${BANK_IMPORT_MAX_BYTES/1048576} MiB)`);
 if(bytes.length>BANK_IMPORT_MAX_BYTES)throw Error('Generated CSV exceeds the limit');
 return bytes;
}
