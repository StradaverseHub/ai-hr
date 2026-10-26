'use client';
import {useId,useMemo,useRef,useState} from 'react';
import {EditorContent,useEditor,useEditorState} from '@tiptap/react';
import type {JSONContent} from '@tiptap/core';
import {letterEditorExtensions} from '@/lib/letter-editor-extensions';
import {letterDocumentFromEditor,letterDocumentToEditor} from '@/lib/letter-editor';
import {sanitiseLetterPaste} from '@/lib/letter-editor-paste';
import {validateLetterDocument,type LetterDocument,type LetterCondition,type LetterField} from '@/lib/letter-model';
import {inputCls} from '@/components/ui';
import {LetterConditionBuilder,type ConditionLabels} from './condition-builder';

export type LetterEditorLabels={body:string;toolbar:string;bold:string;italic:string;underline:string;paragraph:string;heading:string;bulletList:string;orderedList:string;table:string;addRow:string;deleteRow:string;addColumn:string;deleteColumn:string;deleteTable:string;undo:string;redo:string;field:string;insertField:string;conditional:string;then:string;otherwise:string;editCondition:string;apply:string;cancel:string;invalid:string;pasteHelp:string;condition:ConditionLabels};
/** The parent receives every edit, including invalid edits, and must disable save when valid=false. */
export function LetterRichEditor({initial,fields,language,labels,onChange}:{initial:LetterDocument;fields:LetterField[];language:LetterDocument['language'];labels:LetterEditorLabels;onChange:(json:JSONContent,valid:boolean)=>void}){
 const id=useId(),dialog=useRef<HTMLDialogElement>(null),[field,setField]=useState(''),[condition,setCondition]=useState<LetterCondition>({type:'present',field:fields[0]?.key??''}),[editing,setEditing]=useState<number|null>(null),[error,setError]=useState(false),[conditionError,setConditionError]=useState(false);
 // initial is a saved version, not a controlled value: switching versions remounts this component.
 const content=useMemo(()=>letterDocumentToEditor(initial,fields),[initial,fields]);
 const editor=useEditor({immediatelyRender:false,extensions:letterEditorExtensions(labels),content,
  editorProps:{attributes:{id,role:'textbox','aria-label':labels.body,'aria-multiline':'true',class:'min-h-64 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2'},
   transformPastedHTML(html){try{return sanitiseLetterPaste(html);}catch{setError(true);return '';}}},
  onUpdate({editor:current}){const json=current.getJSON();let valid=true;try{letterDocumentFromEditor(json,fields,language);}catch{valid=false;}setError(!valid);onChange(json,valid);},
 });
 const state=useEditorState({editor,selector:({editor:current})=>current?{bold:current.isActive('bold'),italic:current.isActive('italic'),underline:current.isActive('underline'),bulletList:current.isActive('bulletList'),orderedList:current.isActive('orderedList'),table:current.isActive('table'),conditional:current.isActive('letterConditional'),undo:current.can().undo(),redo:current.can().redo()}:null});
 const button='min-h-11 rounded border px-3 text-sm aria-pressed:bg-primary/10 disabled:opacity-50';
 function showCondition(edit:boolean){
  if(!editor)return;setConditionError(false);
  if(edit){
   const position=editor.state.selection.$from;let selected:{condition:unknown;position:number}|null=position.nodeAfter?.type.name==='letterConditional'?{condition:position.nodeAfter.attrs.condition,position:position.pos}:null;
   for(let depth=position.depth;depth>0&&!selected;depth--){const node=position.node(depth);if(node.type.name==='letterConditional')selected={condition:node.attrs.condition,position:position.before(depth)};}
   if(!selected)return;
   try{const checked=validateLetterDocument({version:1,language,blocks:[{type:'if',condition:selected.condition,then:[],otherwise:[]}]},fields);const block=checked.blocks[0];if(block.type!=='if')return;setCondition(block.condition);}catch{setCondition({type:'present',field:fields[0]?.key??''});setConditionError(true);}
   setEditing(selected.position);
  }
  else {setCondition({type:'present',field:fields[0]?.key??''});setEditing(null);}
  dialog.current?.showModal();
 }
 function applyCondition(){
  try{validateLetterDocument({version:1,language,blocks:[{type:'if',condition,then:[],otherwise:[]}]},fields);}catch{setConditionError(true);return;}
  if(!editor)return;
  if(editing!==null){const node=editor.state.doc.nodeAt(editing);if(node?.type.name!=='letterConditional'){setConditionError(true);return;}editor.view.dispatch(editor.state.tr.setNodeMarkup(editing,undefined,{...node.attrs,condition}));}
  else editor.chain().focus().insertContent({type:'letterConditional',attrs:{condition},content:[{type:'letterBranch',attrs:{branch:'then'},content:[{type:'paragraph'}]},{type:'letterBranch',attrs:{branch:'otherwise'},content:[{type:'paragraph'}]}]}).run();
  dialog.current?.close();editor.commands.focus();
 }
 return <div className="space-y-2">
  <p id={`${id}-help`} className="text-sm text-muted-foreground">{labels.pasteHelp}</p>
  <div className="overflow-hidden rounded-md border"><div role="group" aria-label={labels.toolbar} className="flex flex-wrap gap-2 border-b bg-muted/30 p-2">
   <button type="button" className={button} disabled={!editor} aria-pressed={state?.bold??false} onClick={()=>editor?.chain().focus().toggleBold().run()}>{labels.bold}</button>
   <button type="button" className={button} disabled={!editor} aria-pressed={state?.italic??false} onClick={()=>editor?.chain().focus().toggleItalic().run()}>{labels.italic}</button>
   <button type="button" className={button} disabled={!editor} aria-pressed={state?.underline??false} onClick={()=>editor?.chain().focus().toggleUnderline().run()}>{labels.underline}</button>
   <button type="button" className={button} disabled={!editor} onClick={()=>editor?.chain().focus().setParagraph().run()}>{labels.paragraph}</button>
   {([1,2,3] as const).map(level=><button key={level} type="button" className={button} disabled={!editor} onClick={()=>editor?.chain().focus().toggleHeading({level}).run()}>{labels.heading} {level}</button>)}
   <button type="button" className={button} disabled={!editor} aria-pressed={state?.bulletList??false} onClick={()=>editor?.chain().focus().toggleBulletList().run()}>{labels.bulletList}</button>
   <button type="button" className={button} disabled={!editor} aria-pressed={state?.orderedList??false} onClick={()=>editor?.chain().focus().toggleOrderedList().run()}>{labels.orderedList}</button>
   <button type="button" className={button} disabled={!editor||state?.table} onClick={()=>editor?.chain().focus().insertTable({rows:2,cols:2,withHeaderRow:false}).run()}>{labels.table}</button>
   {state?.table&&<>{(['addRowAfter','deleteRow','addColumnAfter','deleteColumn','deleteTable'] as const).map((command,index)=><button key={command} type="button" className={button} onClick={()=>editor?.chain().focus()[command]().run()}>{[labels.addRow,labels.deleteRow,labels.addColumn,labels.deleteColumn,labels.deleteTable][index]}</button>)}</>}
   <button type="button" className={button} disabled={!state?.undo} onClick={()=>editor?.chain().focus().undo().run()}>{labels.undo}</button><button type="button" className={button} disabled={!state?.redo} onClick={()=>editor?.chain().focus().redo().run()}>{labels.redo}</button>
  </div><div className="flex flex-wrap items-end gap-2 border-b p-2"><label className="min-w-0 flex-1 space-y-1 text-sm" htmlFor={`${id}-field`}><span>{labels.field}</span><select id={`${id}-field`} className={`${inputCls} min-h-11`} value={field} onChange={event=>setField(event.target.value)}><option value="">—</option>{fields.map(item=><option key={item.key} value={item.key}>{item.label} · {item.key}</option>)}</select></label><button type="button" className={button} disabled={!editor||!fields.some(item=>item.key===field)} onClick={()=>editor?.chain().focus().insertContent({type:'letterField',attrs:{key:field}}).run()}>{labels.insertField}</button><button type="button" className={button} disabled={!editor||!fields.length} onClick={()=>showCondition(false)}>{labels.conditional}</button>{state?.conditional&&<button type="button" className={button} onClick={()=>showCondition(true)}>{labels.editCondition}</button>}</div>
   <div className="max-h-[65vh] overflow-auto" aria-describedby={`${id}-help`}><EditorContent editor={editor}/></div>
  </div>{error&&<p role="alert" className="text-sm text-destructive">{labels.invalid}</p>}
  <dialog ref={dialog} aria-labelledby={`${id}-condition-title`} className="m-auto max-h-[85vh] w-[min(42rem,calc(100%-2rem))] overflow-auto rounded-lg border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/40"><h3 id={`${id}-condition-title`} className="mb-4 text-lg font-semibold">{labels.conditional}</h3><LetterConditionBuilder condition={condition} fields={fields} onChange={setCondition} labels={labels.condition}/>{conditionError&&<p role="alert" className="mt-3 text-sm text-destructive">{labels.invalid}</p>}<div className="mt-4 flex flex-wrap gap-2"><button type="button" className={button} onClick={applyCondition}>{labels.apply}</button><button type="button" className={button} onClick={()=>{dialog.current?.close();editor?.commands.focus();}}>{labels.cancel}</button></div></dialog>
 </div>;
}
