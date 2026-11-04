/** Hosted-only evidence from the existing fictional payslip fixtures. No renderer or assertion changes. */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
export function payslipPdfDiagnosticsEnabled(){return Boolean(process.env.AIHR_FOCUSED_EVIDENCE_DIR);}
export async function emitPayslipPdfDiagnostic(name:string,bytes:Uint8Array,snapshot:unknown):Promise<void>{
 const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;if(!evidence)return;
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true'||!/^\d+$/.test(process.env.GITHUB_RUN_ID??'')||!/^[a-f0-9]{40}$/.test(process.env.AIHR_CI_HEAD??''))throw Error('Payslip PDF diagnostics require the exact hosted focused candidate.');
 if(!/^[a-z0-9-]+$/.test(name))throw Error('Diagnostic names must be fixed fixture identifiers.');
 const directory=join(evidence,'payslip-pdf-diagnostics');mkdirSync(directory,{recursive:true});
 const base=join(directory,name);writeFileSync(base+'.pdf',bytes);
 let raster:{state:string;pages:string[];detail?:string}={state:'unavailable',pages:[],detail:'PDF retained; /usr/bin/pdftoppm is absent. Render the downloaded actual PDF for visual inspection.'};
 if(existsSync('/usr/bin/pdftoppm')){
  try{execFileSync('/usr/bin/pdftoppm',['-png','-r','100',base+'.pdf',base],{timeout:120000,stdio:'pipe'});raster={state:'rendered',pages:readdirSync(directory).filter(file=>file.startsWith(name+'-')&&file.endsWith('.png')).sort()};}
  catch(error){raster={state:'failed',pages:[],detail:error instanceof Error?error.message:'Rasterizer failed; actual PDF retained.'};}
 }
 writeFileSync(base+'.json',JSON.stringify({schema:'aihr.payslip-pdf-diagnostic.v1',candidate:process.env.AIHR_CI_HEAD,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,fixture:name,provenance:'Actual existing renderPayslipPdf result and fictional fixture/read-model snapshots. No live data, modified golden, parser replacement, calculation repair or installed acceptance.',pdf:name+'.pdf',byteLength:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex'),pageCount:(await PDFDocument.load(bytes)).getPageCount(),raster,snapshot},(_key,value)=>typeof value==='bigint'?{type:'bigint',decimal:value.toString()}:value,2)+'\n');
}
