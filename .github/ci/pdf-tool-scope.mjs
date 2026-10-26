/** Audited external-tool references affect setup only; every test remains mandatory. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const PDF_TOOL_CONSUMERS=Object.freeze(['test/payslip-pdf.test.ts','test/r379-pcb2ii-pdf.test.ts']);
const commentOnly=Object.freeze({
 'lib/borang-8a-pdf.ts':'955f239bf0a2dc56d5618414add516b65b98835d28f51917f3a96b2e55912ba0',
 'lib/borang-8b-pdf.ts':'97a44acc65b1daebc55735efaa46cb4afccd2ee167265164c765ab974d1f1853',
 'lib/cp21-fields.ts':'8d5c68602bfe772d37a20db2b805b2c455779798e692fcfdb52b28ee313667e7',
 'lib/cp22a-fields.ts':'17270092f35270177c53d07988af23accffaff333d329a2116514d70e93003df',
});
const sha=b=>createHash('sha256').update(b).digest('hex');
const reference=/\b(?:pdftoppm|pdftotext|pdfinfo|pymupdf|fitz)\b/i;
const relevant=/^(?:app|components|core|db|lib|localization|mobile|packs|scripts|test)\/.+\.(?:ts|tsx|js|mjs|cjs|mts|cts|py|sh|sql)$/;
export function classifyPdfToolSources(sources){
 const seen=new Set(),references=[];
 for(const row of sources){
  assert(row&&typeof row.path==='string'&&relevant.test(row.path)&&!row.path.split('/').some(p=>!p||p==='.'||p==='..')&&!seen.has(row.path)&&Buffer.isBuffer(row.bytes)&&row.bytes.length<=16*1024**2,'Complete safe unique tool-scope source required');seen.add(row.path);
  if(!reference.test(row.bytes.toString('utf8')))continue;
  const digest=sha(row.bytes);
  assert(PDF_TOOL_CONSUMERS.includes(row.path)||Object.hasOwn(commentOnly,row.path)&&commentOnly[row.path]===digest,'Unknown/changed external PDF-tool reference needs source review: '+row.path);
  references.push({path:row.path,sha256:digest,kind:PDF_TOOL_CONSUMERS.includes(row.path)?'tool-suite':'byte-pinned-comment-only'});
 }
 assert(seen.size>0,'Nonempty complete tool-scope inventory required');
 assert(PDF_TOOL_CONSUMERS.every(path=>references.some(r=>r.path===path))&&Object.keys(commentOnly).every(path=>references.some(r=>r.path===path)),'Audited PDF source inventory changed; review scope before planning');
 references.sort((a,b)=>a.path.localeCompare(b.path));
 return {strategy:'audited-external-pdf-suite-v1',consumers:[...PDF_TOOL_CONSUMERS],referenceSources:references,scannedSources:seen.size,referenceFingerprint:sha(JSON.stringify(references))};
}
export function inspectPdfToolScope(cwd){
 const paths=execFileSync('git',['ls-files'],{cwd,encoding:'utf8',maxBuffer:8*1024**2}).trim().split('\n').filter(p=>relevant.test(p)).sort();
 function* sources(){for(const path of paths){const p=join(cwd,path),s=lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=16*1024**2,'Regular bounded tool-scope source required');yield {path,bytes:readFileSync(p)};}}
 return classifyPdfToolSources(sources());
}
