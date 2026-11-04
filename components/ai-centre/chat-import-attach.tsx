'use client';
/** AI v2 Phase 1, slice 3 (issue 16b) — attach a file to import, in Ask's composer.
 *
 * The file is read in this browser with the import pages' own reader (lib/import-file.ts readImportFile: a workbook
 * becomes the CSV text its page would send; a time-clock .txt is read as text), within the same size limits. The text
 * travels with the next question to the chat command, which hands it to the import owner, never to the model. It stays
 * in this tab's memory with the question it was sent with (TurnImportFile) only so that turn's prepared card can send it
 * back with Confirm or hand it to the import page with "Fix the rows"; it is never put in a URL, browser storage or the
 * stored chat. The server checks on Confirm that it is the very file the card was prepared from. */
import {createContext,useCallback,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Paperclip,X} from 'lucide-react';
import {readImportFile} from '@/lib/import-file';
import {CHAT_IMPORT_ACCEPT,CHAT_IMPORT_MAX_FILE_BYTES,CHAT_IMPORT_MAX_TEXT_BYTES,chatImportFormat,type ChatImportFile} from '@/lib/chat-import';

export type AttachedImport=ChatImportFile&Readonly<{size:number;rows:number}>;
/** The file sent with the question whose answer this is (components/assistant/workspace-conversation.tsx). */
export const TurnImportFile=createContext<ChatImportFile|null>(null);

export class ChatImportReadError extends Error{constructor(readonly code:'type'|'size'|'empty'|'read'){super(code);this.name='ChatImportReadError';}}
const dataRows=(text:string)=>Math.max(0,text.split(/\r?\n/).filter(line=>line.trim()).length-1);
/** Reads one picked file the way its import page would. */
export async function readChatImportFile(file:File):Promise<AttachedImport>{
 const format=chatImportFormat(file.name);
 if(!format)throw new ChatImportReadError('type');
 if(file.size>CHAT_IMPORT_MAX_FILE_BYTES)throw new ChatImportReadError('size');
 let text:string;
 if(format==='txt'){
  if(file.size>CHAT_IMPORT_MAX_TEXT_BYTES)throw new ChatImportReadError('size');
  try{text=(await file.text()).replace(/^﻿/,'');}catch{throw new ChatImportReadError('read');}
 }else{
  try{text=(await readImportFile(file,{maxFileBytes:CHAT_IMPORT_MAX_FILE_BYTES,maxCsvBytes:CHAT_IMPORT_MAX_TEXT_BYTES})).text.replace(/^﻿/,'');}
  catch(error){const code=(error as {code?:string})?.code;throw new ChatImportReadError(code==='FILE_TOO_LARGE'?'size':code==='EMPTY_FILE'||code==='EMPTY_SHEET'?'empty':code==='UNSUPPORTED_FILE_TYPE'?'type':'read');}
 }
 if(!text.trim())throw new ChatImportReadError('empty');
 if(new TextEncoder().encode(text).byteLength>CHAT_IMPORT_MAX_TEXT_BYTES)throw new ChatImportReadError('size');
 return Object.freeze({name:file.name,format,text,size:file.size,rows:format==='txt'?dataRows(text)+1:dataRows(text)});
}

/** The chip a sent question carries: the file's name and its rows, as the person attached it. */
export function AttachedFileChip({file,onRemove}:{file:Pick<AttachedImport,'name'|'rows'>;onRemove?:()=>void}){
 const t=useTranslations('chatImport');
 return <span data-chat-import-file className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
  <Paperclip aria-hidden className="size-3.5 flex-none"/>
  <span className="min-w-0 truncate">{t('fileChip',{name:file.name,count:file.rows})}</span>
  {onRemove&&<button type="button" onClick={onRemove} aria-label={t('remove',{name:file.name})} title={t('remove',{name:file.name})}
   className="-my-1 -mr-1 inline-flex size-8 flex-none items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:size-11"><X aria-hidden className="size-3.5"/></button>}
 </span>;
}

/** The composer's paperclip, its hidden picker and the chip of the file waiting to be sent with the next question. */
export function useChatImportAttachment(disabled:boolean){
 const t=useTranslations('chatImport');
 const picker=useRef<HTMLInputElement>(null),epoch=useRef(0);
 const [file,setFile]=useState<AttachedImport|null>(null),[error,setError]=useState<string|null>(null),[reading,setReading]=useState(false);
 const clear=useCallback(()=>{epoch.current++;setFile(null);setError(null);setReading(false);},[]);
 const load=async(files:readonly File[])=>{
  const at=++epoch.current;setError(null);
  if(files.length!==1){setError(t('errors.one'));return;}
  setReading(true);
  try{const read=await readChatImportFile(files[0]);if(at===epoch.current)setFile(read);}
  catch(failure){if(at===epoch.current){setFile(null);setError(t('errors.'+(failure instanceof ChatImportReadError?failure.code:'read')));}}
  finally{if(at===epoch.current)setReading(false);if(picker.current)picker.current.value='';}
 };
 const controls=<>
  <button type="button" disabled={disabled||reading} aria-label={t('attach')} title={t('attach')} data-chat-import-attach onClick={()=>picker.current?.click()}
   className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"><Paperclip aria-hidden className="size-4"/></button>
  <input ref={picker} type="file" accept={CHAT_IMPORT_ACCEPT} className="sr-only" aria-label={t('attach')} tabIndex={-1} onChange={event=>void load(Array.from(event.target.files??[]))}/>
 </>;
 const chip=(file||error||reading)?<div className="flex flex-wrap items-center gap-2 px-3 pt-3">
  {file&&<AttachedFileChip file={file} onRemove={clear}/>}
  {reading&&<span role="status" className="text-xs text-muted-foreground">{t('reading')}</span>}
  {error&&<span role="alert" className="text-xs text-destructive">{error}</span>}
 </div>:null;
 return {file,controls,chip,clear,reading,load};
}
