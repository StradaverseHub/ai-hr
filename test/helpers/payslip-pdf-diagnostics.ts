/** Hosted-only evidence from the existing fictional payslip fixtures. No renderer or assertion changes. */
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
export function payslipPdfDiagnosticsEnabled(){return Boolean(process.env.AIHR_FOCUSED_EVIDENCE_DIR);}
export async function emitPayslipPdfDiagnostic(name:string,bytes:Uint8Array,snapshot:unknown):Promise<void>{
 const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;if(!evidence)return;
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true'||!/^\d+$/.test(process.env.GITHUB_RUN_ID??'')||!/^[a-f0-9]{40}$/.test(process.env.AIHR_CI_HEAD??''))throw Error('Payslip PDF diagnostics require the exact hosted focused candidate.');
 if(!/^[a-z0-9-]+$/.test(name))throw Error('Diagnostic names must be fixed fixture identifiers.');
 const directory=join(evidence,'payslip-pdf-diagnostics');mkdirSync(directory,{recursive:true});
 const base=join(directory,name);writeFileSync(base+'.pdf',bytes);
 writeFileSync(base+'.json',JSON.stringify({schema:'aihr.payslip-pdf-diagnostic.v1',candidate:process.env.AIHR_CI_HEAD,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,fixture:name,provenance:'Actual existing renderPayslipPdf result and fictional fixture/read-model snapshots. No live data, modified golden, parser replacement, calculation repair or installed acceptance.',pdf:name+'.pdf',byteLength:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex'),pageCount:(await PDFDocument.load(bytes)).getPageCount(),visualInspection:'Render the retained actual PDF through the controlled document-review toolchain; this capture adds no external-tool prerequisite.',snapshot},(_key,value)=>typeof value==='bigint'?{type:'bigint',decimal:value.toString()}:value,2)+'\n');
}
