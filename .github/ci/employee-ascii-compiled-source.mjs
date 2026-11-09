/** Immutable historical-byte reconstruction for protected log replay only.
 * This never imports/executes candidate application, Drizzle or SQL code. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const EMPLOYEE_ASCII_TEMPLATE_SHA256="e1468e77942f4f2dc557d729be7eb42683d844bc92288e127fd2b6a095ad6b92";
export const EMPLOYEE_ASCII_COMPILED_SHA256="10b0d44d8943fdfbb76e748028e8fbd2938a514ea22c57b70cfcc665b6a41743";
const historicalEdits=Object.freeze([
 {
  "marker": "/* EMPLOYEE_CHOICE_ASCII_NAME */",
  "before": "translate(replace(p.name,U&'\\0130',U&'i\\0307'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ'||U&'\\212A','abcdefghijklmnopqrstuvwxyzk')"
 },
 {
  "marker": "/* EMPLOYEE_CHOICE_ASCII_CODE */",
  "before": "translate(replace(coalesce(p.\"employeeCode\",''),U&'\\0130',U&'i\\0307'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ'||U&'\\212A','abcdefghijklmnopqrstuvwxyzk')"
 }
].map(row=>Object.freeze(row)));
const hash=value=>createHash('sha256').update(value).digest('hex');
/** Both independent whole-byte pins are mandatory; caller metadata is no issuer. */
export function employeeAsciiCompiledSource(template){
 assert(Buffer.isBuffer(template)&&template.length>0&&template.length<=1048576,'Bounded committed ASCII template required');
 assert.equal(hash(template),EMPLOYEE_ASCII_TEMPLATE_SHA256,'Committed ASCII template source changed');
 let source=template.toString('utf8');
 for(const {marker,before}of historicalEdits){assert.equal(source.split(marker).length,2,'Exact single historical ASCII marker required');source=source.replace(marker,before);}
 const compiled=Buffer.from(source,'utf8');assert.equal(hash(compiled),EMPLOYEE_ASCII_COMPILED_SHA256,'Historical complete compiled SQL bytes differ');return compiled;
}
/** Actual template and actual compiled witness must never be interchanged. */
export function employeeAsciiSourceWitness(witness,template){
 const compiled=employeeAsciiCompiledSource(template);assert(witness&&typeof witness==='object');
 assert.equal(witness.templateSha256,hash(template),'Native template witness differs');
 assert.equal(witness.sourceSha256,hash(compiled),'Native compiled SQL witness differs');return compiled;
}
