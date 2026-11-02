/** Build-only projection: every mail translation is retained; unrelated application UI data stays out. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import ts from 'typescript';
import type {Plugin} from 'esbuild';
export const MAIL_LOCALES=['en','ms','zh','vi','ta','th'] as const;
const readers=['deploy/identity-email/notification-message.ts','lib/assessment-reminder-message.ts'];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function reviewCatalogueReader(text:string,filename:string,root=process.cwd()){
 const source=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),bindings=new Map<string,ts.Identifier>();
 for(const statement of source.statements){
  if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier))continue;
  const match=statement.moduleSpecifier.text.match(/(?:^|\/)messages\/(en|ms|zh|vi|ta|th)\.json$/);if(!match)continue;
  const name=statement.importClause?.name;assert(name&&name.text===match[1]&&!statement.importClause?.isTypeOnly,'Exact default locale import required');
  assert.equal(resolve(dirname(filename),statement.moduleSpecifier.text),join(resolve(root),'messages',match[1]+'.json'),'Canonical locale source required');
  assert(!bindings.has(name.text),'Duplicate locale import');bindings.set(name.text,name);
 }
 assert.deepEqual([...bindings.keys()].sort(),[...MAIL_LOCALES].sort(),'All six mail locales required');
 const reads=new Set<string>();
 function visit(node:ts.Node){
  if(ts.isIdentifier(node)&&bindings.has(node.text)){
   const parent=node.parent;
   if(bindings.get(node.text)===node)return;
   if(ts.isPropertyAssignment(parent)&&parent.name===node)return;
   assert(ts.isPropertyAccessExpression(parent)&&parent.expression===node&&parent.name.text==='workflowEmail','Unreviewed locale access');reads.add(node.text);
  }
  ts.forEachChild(node,visit);
 }
 visit(source);assert.deepEqual([...reads].sort(),[...MAIL_LOCALES].sort(),'Every retained locale needs an actual mail namespace reader');
 return {path:relative(resolve(root),filename),sha256:hash(text)};
}
export function mailCatalogueProjection(root=process.cwd()){
 const project=resolve(root),consumerReviews=new Map<string,ReturnType<typeof reviewCatalogueReader>>(),projections=new Map<string,{locale:string;path:string;sourceSha256:string;selectedSha256:string;sourceBytes:number;selectedBytes:number;namespace:'workflowEmail'}>();
 const plugin:Plugin={name:'source-owned-mail-catalogues',setup(build){
  build.onResolve({filter:/messages\/(?:en|ms|zh|vi|ta|th)\.json$/},async args=>{
   const importer=resolve(args.importer),name=relative(project,importer);assert(readers.includes(name)&&args.kind==='import-statement','Unreviewed catalogue consumer');
   if(!consumerReviews.has(name))consumerReviews.set(name,reviewCatalogueReader(await readFile(importer,'utf8'),importer,project));
   return undefined;
  });
  build.onLoad({filter:/[\\/]messages[\\/](?:en|ms|zh|vi|ta|th)\.json$/},async args=>{
   const match=args.path.match(/(?:^|[\\/])(en|ms|zh|vi|ta|th)\.json$/)!;assert.equal(resolve(args.path),join(project,'messages',match[1]+'.json'));
   const text=await readFile(args.path,'utf8'),data=JSON.parse(text);assert(data.workflowEmail&&typeof data.workflowEmail==='object'&&!Array.isArray(data.workflowEmail),'Complete mail namespace required');
   const selected=JSON.stringify({workflowEmail:data.workflowEmail});
   projections.set(match[1],{locale:match[1],path:relative(project,args.path),sourceSha256:hash(text),selectedSha256:hash(selected),sourceBytes:Buffer.byteLength(text),selectedBytes:Buffer.byteLength(selected),namespace:'workflowEmail'});
   return {contents:selected,loader:'json',resolveDir:dirname(args.path)};
  });
 }};
 return {plugin,evidence(){assert.deepEqual([...consumerReviews.keys()].sort(),[...readers].sort());assert.deepEqual([...projections.keys()].sort(),[...MAIL_LOCALES].sort());return {consumers:[...consumerReviews.values()].sort((a,b)=>a.path.localeCompare(b.path)),locales:[...projections.values()].sort((a,b)=>a.locale.localeCompare(b.locale))};}};
}
