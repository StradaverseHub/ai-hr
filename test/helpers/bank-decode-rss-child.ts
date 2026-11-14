/** MEASUREMENT ONLY (never merged): one Bank queued-tick decode in a fresh process; prints peak RSS. */
import {closeSync,fstatSync,openSync,readSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {decodeBankImportSource} from '../../lib/bank-import-source.server';
import {BANK_IMPORT_STAGE_ROWS,bankImportStagedRecords,stageBankImportSource} from '../../lib/bank-import-stream-source.server';
async function main(){
const [mode,path]=process.argv.slice(2);
const name=path.endsWith('.csv')?'bank-statutory.csv':'bank-statutory.xlsx';
// 1 MiB parts read separately, as the worker receives bank_import_chunk rows.
const fd=openSync(path,'r'),size=fstatSync(fd).size,parts:Buffer[]=[];
for(let offset=0;offset<size;offset+=1048576){const part=Buffer.alloc(Math.min(1048576,size-offset));readSync(fd,part,0,part.length,offset);parts.push(part);}
closeSync(fd);
const baseline=process.memoryUsage().rss;
const started=performance.now();
let rows=0,payloadBytes=0;
if(mode==='new'){
 const staged=await stageBankImportSource(name,parts);
 for(let batch=0;batch<staged.batches.length;batch++){
  const start=batch*BANK_IMPORT_STAGE_ROWS;
  const payload=JSON.stringify(bankImportStagedRecords(staged,batch).map((record,i)=>({ordinal:start+i+1,record,error:staged.errors.get(start+i+1)??null})));
  payloadBytes+=payload.length;rows+=Math.min(BANK_IMPORT_STAGE_ROWS,staged.total-start);
 }
}else{
 const content=Buffer.concat(parts);parts.length=0;
 const decoded=await decodeBankImportSource(name,content);
 for(let start=0;start<decoded.records.length;start+=1000){
  const payload=JSON.stringify(decoded.records.slice(start,start+1000).map((record,i)=>({ordinal:start+i+1,record,error:decoded.errors.get(start+i+1)??null})));
  payloadBytes+=payload.length;
 }
 rows=decoded.records.length;
}
const seconds=(performance.now()-started)/1000;
console.log('RESULT '+JSON.stringify({mode,rows,payloadBytes,seconds:Number(seconds.toFixed(2)),baselineRssMiB:Math.round(baseline/1048576),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
}
main().catch(error=>{console.error(error);process.exit(1);});
