import {Node} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {TableKit} from '@tiptap/extension-table';
/** The editor exposes only formatting the canonical document can preserve. No link/image/code extensions. */
export function letterEditorExtensions(labels:{conditional:string;then:string;otherwise:string}){
 const field=Node.create({name:'letterField',group:'inline',inline:true,atom:true,selectable:true,
  addAttributes(){return {key:{default:'',parseHTML:element=>element.getAttribute('data-letter-field')}};},
  parseHTML(){return [{tag:'span[data-letter-field]'}];},
  renderHTML({node}){return ['span',{'data-letter-field':node.attrs.key,contenteditable:'false',class:'rounded bg-primary/10 px-1 font-medium text-primary'},'{{'+String(node.attrs.key)+'}}'];},
 });
 const branch=Node.create({name:'letterBranch',content:'block+',isolating:true,defining:true,
  addAttributes(){return {branch:{default:'then',parseHTML:element=>element.getAttribute('data-letter-branch')}};},
  parseHTML(){return [{tag:'section[data-letter-branch]',contentElement:'[data-letter-branch-content]'}];},
  renderHTML({node}){return ['section',{'data-letter-branch':node.attrs.branch,class:'mt-2 rounded border border-dashed p-3'},['div',{contenteditable:'false',class:'text-xs font-medium text-muted-foreground'},node.attrs.branch==='then'?labels.then:labels.otherwise],['div',{'data-letter-branch-content':'true'},0]];},
 });
 const conditional=Node.create({name:'letterConditional',group:'block',content:'letterBranch letterBranch',isolating:true,defining:true,
  addAttributes(){return {condition:{default:null,parseHTML:element=>{const value=element.getAttribute('data-letter-condition');if(!value||value.length>16000)return null;try{return JSON.parse(value);}catch{return null;}}}};},
  parseHTML(){return [{tag:'section[data-letter-conditional]',contentElement:'[data-letter-conditional-content]'}];},
  renderHTML({node}){return ['section',{'data-letter-conditional':'true','data-letter-condition':JSON.stringify(node.attrs.condition),class:'my-4 rounded-md border p-3'},['div',{contenteditable:'false',class:'text-sm font-semibold'},labels.conditional],['div',{'data-letter-conditional-content':'true'},0]];},
 });
 return [StarterKit.configure({blockquote:false,codeBlock:false,code:false,horizontalRule:false,link:false,strike:false,trailingNode:false,heading:{levels:[1,2,3]}}),TableKit.configure({table:{resizable:false}}),field,branch,conditional];
}
