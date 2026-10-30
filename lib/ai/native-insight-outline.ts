/** Pure presentation metadata shared by native source owners and client rendering. No source
 * authority, database, provider, secrets or model admission is available from this module. */
export const NATIVE_OUTLINE_KINDS=['summary','evidence','discussion','decision','plan','history','current','remark'] as const;
export type NativeOutlineSection=Readonly<{index:number;kind:typeof NATIVE_OUTLINE_KINDS[number];text:string}>;
export type NativeInsightOutline=Readonly<{operation:'native_outline_selection';order:readonly number[];sections:readonly NativeOutlineSection[]}>;
/** Only slice an already-returned native paragraph. Preserve quoted remarks and every sentence. */
export function nativeParagraphOutline(text:string,kind:NativeOutlineSection['kind']='summary'):readonly NativeOutlineSection[]{
 if(typeof text!=='string'||!text.trim()||text.length>65536||!NATIVE_OUTLINE_KINDS.includes(kind))throw Error('Invalid native outline paragraph.');
 const pieces:string[]=[];let start=0,quoted=false;
 for(let index=0;index<text.length;index++){const c=text[index];if(c==='“')quoted=true;else if(c==='”')quoted=false;else if(c==='"')quoted=!quoted;if(!quoted&&/[.!?]/.test(c)&&/\s/.test(text[index+1]??'')&&pieces.length<23){const sentence=text.slice(start,index+1).trim();if(sentence)pieces.push(sentence);start=index+1;}}
 const tail=text.slice(start).trim();if(tail)pieces.push(tail);return Object.freeze(pieces.map((text,index)=>Object.freeze({index,kind,text})));
}
