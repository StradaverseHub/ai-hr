import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyPdfToolSources,inspectPdfToolScope,PDF_TOOL_CONSUMERS} from './pdf-tool-scope.mjs';
const paths=[...PDF_TOOL_CONSUMERS,'lib/borang-8a-pdf.ts','lib/borang-8b-pdf.ts','lib/cp21-fields.ts','lib/cp22a-fields.ts'];
const fixture=()=>paths.map(path=>({path,bytes:readFileSync(new URL('../../'+path,import.meta.url))}));
test('all actual audited tool consumers retain the complete toolchain and comment-only references remain byte pinned',()=>{
 const r=classifyPdfToolSources(fixture());assert.deepEqual(r.consumers,[...PDF_TOOL_CONSUMERS]);assert.equal(r.referenceSources.length,6);assert.equal(r.referenceSources.filter(s=>s.kind==='byte-pinned-comment-only').length,4);assert.match(r.referenceFingerprint,/^[a-f0-9]{64}$/);
});
test('new direct, helper, Python or SQL tool references stop planning instead of silently omitting dependencies',()=>{
 for(const [path,text] of [['test/new.test.ts',"execFileSync('pdftotext')"],['lib/helper.ts',"'pdftoppm'"],['scripts/render.py','import fitz'],['db/migrations/9999_tool.sql',"COPY x TO PROGRAM 'pdfinfo'"],['core/dependency.ts','PyMuPDF']])assert.throws(()=>classifyPdfToolSources([...fixture(),{path,bytes:Buffer.from(text)}]),/needs source review/);
});
test('changed exempted comments/code, missing inventory, duplicates and unsafe source paths refuse',()=>{
 const changed=fixture();changed[2].bytes=Buffer.concat([changed[2].bytes,Buffer.from('\n')]);assert.throws(()=>classifyPdfToolSources(changed));
 for(const sources of [[],fixture().slice(1),[...fixture(),fixture()[0]],[...fixture(),{path:'lib/../escape.ts',bytes:Buffer.from('fitz')}]])assert.throws(()=>classifyPdfToolSources(sources));
});
