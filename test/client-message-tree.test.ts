import {expect,it} from 'vitest';
import {personnelClientMessageKeys} from '../scripts/personnel-message-contract';
import {additionalClientMessages,mergeClientMessages,pickClientMessages,type ClientMessages} from '../lib/client-message-tree';
it('selects nested namespaces without mutating shared input or duplicating parent prefixes',()=>{
 const messages={common:{ok:'Okay',cancel:'Cancel'},claims:{form:{save:'Save'},history:'History'}};
 const original=JSON.stringify(messages);
 expect(pickClientMessages(messages,['claims.form','common','claims'])).toEqual(messages);
 expect(pickClientMessages(messages,['claims.form'])).toEqual({claims:{form:{save:'Save'}}});
 expect(JSON.stringify(messages)).toBe(original);
});
it('keeps the full catalog for unknown usage and omits keys absent from the source',()=>{
 const messages={common:{ok:'Okay'}};
 expect(pickClientMessages(messages,null)).toBe(messages);
 expect(pickClientMessages(messages,['unknown'])).toEqual({});
});
it('sends only the additional route messages and merges overlapping namespace branches on navigation',()=>{
 const messages={onehr:{workspace:{title:'Workspace'},review:{title:'Review'}},common:{ok:'Okay'},claims:{title:'Claims'}};
 const shared=pickClientMessages(messages,['onehr.workspace','common']);
 const additional=additionalClientMessages(messages,shared);
 expect(additional).toEqual({onehr:{review:{title:'Review'}},claims:{title:'Claims'}});
 expect(mergeClientMessages(shared,additional)).toEqual(messages);
 expect(mergeClientMessages(shared,{})).toBe(shared);
 expect(shared).toEqual({onehr:{workspace:{title:'Workspace'}},common:{ok:'Okay'}});
});
it('treats prototype-shaped keys as inert catalog data',()=>{
 const messages=JSON.parse('{"__proto__":{"title":"Label"},"common":{"ok":"Okay"}}') as ClientMessages;
 const selected=pickClientMessages(messages,['__proto__.title']);
 expect(Object.getPrototypeOf(selected)).toBe(Object.prototype);
 expect(Object.hasOwn(selected,'__proto__')).toBe(true);
 expect(mergeClientMessages({},selected)).toEqual(selected);
});

it('preserves every selected locale value and keeps the Claims payload below 30% of the full catalog',async()=>{
 const fs=await import('node:fs'),path=await import('node:path'),url=await import('node:url');
 const root=url.fileURLToPath(new URL('..',import.meta.url));
 const scopes=JSON.parse(fs.readFileSync(path.join(root,'i18n/client-message-scopes.json'),'utf8'));
 const evidence=[];
 for(const locale of ['en','ms','zh','ta','th','vi']){
  const messages=JSON.parse(fs.readFileSync(path.join(root,'messages',locale+'.json'),'utf8')) as ClientMessages;
  const shared=pickClientMessages(messages,scopes.shared.prefixes);
  for(const segment of ['claims','leave','attendance','performance','payroll','me','admin']){
   const selected=pickClientMessages(messages,scopes.segments[segment].prefixes),additional=additionalClientMessages(selected,shared);
   const merged=mergeClientMessages(shared,additional);
   expect(merged).toEqual(mergeClientMessages(shared,selected));
   const bytes=Buffer.byteLength(JSON.stringify(shared))+Buffer.byteLength(JSON.stringify(additional)),fullBytes=Buffer.byteLength(JSON.stringify(messages));
   if(locale==='en'&&segment==='claims')expect(bytes).toBeLessThan(fullBytes*.3);
   if(segment==='me'){
    const at=(tree:ClientMessages,key:string)=>key.split('.').reduce<unknown>((value,part)=>value&&typeof value==='object'&&Object.hasOwn(value,part)?(value as Record<string,unknown>)[part]:undefined,tree);
    for(const key of personnelClientMessageKeys())if(at(messages,key)!==undefined)expect(at(merged,key),key).toEqual(at(messages,key));
   }
   evidence.push({locale,segment,bytes,fullBytes});
  }
 }
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'client-message-bytes.json'),JSON.stringify(evidence,null,2));
});
