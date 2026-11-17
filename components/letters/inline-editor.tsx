'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {EditorContent,useEditor} from '@tiptap/react';
import type {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {letterFieldExtension} from '@/lib/letter-editor-extensions';
import type {LetterEditorNode} from '@/lib/letter-editor';
import {letterInlineStringFromEditor,letterInlineStringParts,letterInlineStringToEditor} from '@/lib/letter-inline-string';
import {inputCls} from '@/components/ui';
type Props={value:string;label:string;fields:ReadonlyMap<string,string>;disabled?:boolean;cell?:boolean;onChange:(value:string)=>void;onValidityChange?:(valid:boolean)=>void;copy:{field:string;unknown:string;invalid:string}};
type Snapshot={json:LetterEditorNode;text:string;invalid:boolean;value?:string};
/** A table may have hundreds of cells. Only the focused field mounts a ProseMirror view. */
export function LetterInlineEditor(props:Props){
 const {value,label,fields,disabled=false,cell=false,copy}=props,id=useId(),container=useRef<HTMLDivElement>(null),lastValue=useRef(value),activating=useRef(false),[pasteRejected,setPasteRejected]=useState(false),[active,setActive]=useState(false),[draft,setDraft]=useState<Snapshot|null>(null);
 useEffect(()=>{if(value!==lastValue.current){lastValue.current=value;setDraft(null);}},[value]);
 const displayed=draft?.invalid?draft.text:value,parts=letterInlineStringParts(displayed,fields),invalid=draft?.invalid??false;
 function changed(snapshot:Snapshot){setPasteRejected(false);setDraft(snapshot);props.onValidityChange?.(!snapshot.invalid);if(snapshot.value!==undefined){lastValue.current=snapshot.value;props.onChange(snapshot.value);}}
 return <div ref={container} className="min-w-0 space-y-1" onBlur={()=>{if(activating.current)return;queueMicrotask(()=>{if(!container.current?.contains(document.activeElement))setActive(false);});}}>
  <span className="text-sm" id={`${id}-label`}>{label}</span>
  {active?<ActiveInlineEditor key={id} {...props} initial={draft?.invalid?draft.json:letterInlineStringToEditor(value,fields)} snapshot={changed} reject={()=>setPasteRejected(true)} ready={()=>{activating.current=false;}}/>:<div role="textbox" aria-label={label} aria-multiline={!cell} aria-readonly={disabled} tabIndex={disabled?-1:0} className="min-h-11 whitespace-pre-wrap break-words rounded-md border bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring" onFocus={()=>{if(!disabled){activating.current=true;setActive(true);}}}>{parts.content.length?parts.content.map((part,index)=>part.type==='field'?<span key={index} data-letter-field={part.key} contentEditable={false} className="rounded bg-primary/10 px-1 font-medium text-primary">{'{'+fields.get(part.key)+'}'}</span>:<span key={index}>{part.text}</span>):<br/>}</div>}
  {(invalid||pasteRejected)&&<p role="alert" className="text-sm text-destructive">{copy.invalid}</p>}{parts.unknown.length>0&&<p role="status" className="text-sm text-amber-800 dark:text-amber-200">{copy.unknown} {parts.unknown.join(', ')}</p>}
 </div>;
}
/** Restricted inline schema shares the Contract atom; no rich document model is persisted. */
function ActiveInlineEditor({label,fields,disabled=false,cell=false,copy,initial,snapshot,reject,ready}:{initial:LetterEditorNode;snapshot:(value:Snapshot)=>void;reject:()=>void;ready:()=>void}&Props){
 const editorRef=useRef<Editor|null>(null),latest=useRef({fields,cell,snapshot,reject,ready}),[pickerOpen,setPickerOpen]=useState(false);latest.current={fields,cell,snapshot,reject,ready};
 function publish(current:Editor){const json=current.getJSON() as LetterEditorNode;try{const next=letterInlineStringFromEditor(json,latest.current.fields,latest.current.cell);latest.current.snapshot({json,text:next,invalid:false,value:next});}catch{latest.current.snapshot({json,text:current.getText({blockSeparator:'\n'}),invalid:true});}}
 const editor=useEditor({immediatelyRender:false,editable:!disabled,extensions:[StarterKit.configure({blockquote:false,bold:false,bulletList:false,code:false,codeBlock:false,dropcursor:false,gapcursor:false,heading:false,horizontalRule:false,italic:false,link:false,listItem:false,listKeymap:false,orderedList:false,strike:false,trailingNode:false,underline:false}),letterFieldExtension(fields)],content:initial,
  editorProps:{attributes:{role:'textbox','aria-label':label,'aria-multiline':String(!cell),class:'min-h-11 whitespace-pre-wrap break-words p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring'},
   handleKeyDown(_view,event){if(event.key==='Enter'){event.preventDefault();if(!latest.current.cell)editorRef.current?.commands.setHardBreak();return true;}return false;},
   handlePaste(_view,event){const text=event.clipboardData?.getData('text/plain');if(text===undefined)return false;event.preventDefault();if(text.length>20000||latest.current.cell&&/[|\r\n]/.test(text)){latest.current.reject();return true;}editorRef.current?.commands.insertContent(letterInlineStringToEditor(text,latest.current.fields).content?.[0].content??[]);return true;},
  },onUpdate({editor:current}){publish(current);},
 });
 editorRef.current=editor;
 useEffect(()=>{if(!editor)return;editor.commands.setTextSelection(editor.state.doc.content.size-1);editor.view.focus();latest.current.ready();},[editor]);
 useEffect(()=>{editor?.setEditable(!disabled);},[editor,disabled]);
 return <><div className="rounded-md border bg-background"><EditorContent editor={editor}/></div><select className={`${inputCls} text-sm`} aria-label={`${label}: ${copy.field}`} disabled={disabled||!editor} value="" onFocus={()=>setPickerOpen(true)} onChange={event=>{if(fields.has(event.target.value))editor?.chain().focus().insertContent({type:'letterField',attrs:{key:event.target.value}}).run();}}><option value="">{copy.field}</option>{pickerOpen&&[...fields].map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></>;
}
