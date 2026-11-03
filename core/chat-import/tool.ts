/** AI v2 Phase 1, slice 3 (issue 16b) — the harness's `prepare_import`: "help me import data" answered with "Yes, I can",
 * and an attached file turned into a prepared import card.
 *
 * Offered (core/harness/tools.ts) only to a caller with at least one import they may prepare here
 * (core/chat-import/kinds.ts), and only on a turn whose gate allows actions. The model passes at most the kind, from the
 * capability catalogue entry the person picked, or the number they chose; the file comes from the turn itself
 * (ToolScope.importFile), never from the model, and the model is never shown it:
 *  - no file this turn: the person's imports, numbered, and how to attach the file (or open the import page);
 *  - a file, but which import is unclear: the same numbered list, for one question; nothing is prepared;
 *  - a file and a clear kind: the native preparer (core/proposals/chat-import.ts) previews it through the owner as the
 *    caller and signs the card; the model gets the kind, counts and issue categories only, disclosed under
 *    core/semantic-model/entities-imports.ts.
 * Instructions inside the file cannot reach the model: no cell is in anything returned here. */
import type {SessionContext} from '../../db/client';
import type {AiToolSpec} from '../../lib/ai/types';
import type {ChatImportFile} from '../../lib/chat-import';
import type {Proposal} from '../proposals/proposal';
import {prepareChatImportProposal} from '../proposals/chat-import';
import {resolveChatImportKind,type ChatImportKindInfo} from './kinds';
import {issueCounts} from './previews';

export const PREPARE_IMPORT_TOOL='prepare_import' as const;
const DESCRIPTION='Prepare an import from a file the person attaches in this chat, for them to review and confirm on its card. Call it when the person wants to import data, or attaches a file to import. kind is an import id from product_capabilities (or its catalogue id) when the person picked one; choice is the number they chose from a list this tool gave. The file is read by the product, never shown to you; you get only the kind, row counts and kinds of issue. Nothing is imported until the person confirms.';
export function prepareImportSpec(kinds:readonly ChatImportKindInfo[]):AiToolSpec{
 return Object.freeze({name:PREPARE_IMPORT_TOOL,description:DESCRIPTION,inputSchema:Object.freeze({type:'object',properties:{
  kind:{type:'string',enum:[...kinds.map(row=>row.kind),...kinds.map(row=>'import:'+row.kind)]},
  choice:{type:'string',pattern:'^\\d{1,2}$',description:'The number the person chose from the numbered imports.'}},additionalProperties:false}) as AiToolSpec['inputSchema']});
}

export const FILE_NOTE='No file is attached yet, so nothing is prepared. Start with "Yes, I can import that here." If the person has not said which data it is, ask which, with the options numbered as given. Ask them to attach the file with the paperclip beside the message box; the product reads it and it is never shown to you. They can also use the import page linked for each option.';
export const ASK_NOTE='A file is attached, but which import it is for is not clear. Nothing is prepared. Ask one short question with the options numbered as given, and ask for the number; never guess.';
export const FORMAT_NOTE='This import does not take that type of file (formats lists what it takes). Nothing is prepared. Say so in one line.';
export const NOT_PERMITTED_NOTE='This person cannot import this into this company here. Nothing is prepared. Say so in one line; never suggest a way around it.';
export const UNREADABLE_NOTE='The import could not read any rows in the file: it may be empty or not laid out like the import\'s template. Nothing is prepared. Say so in one line and point to the import page, which has the template.';
export const PREPARED_NOTE='The import is prepared on its card for the person to review and confirm; nothing is imported until they press Confirm. In one or two sentences say "I\'ve prepared the <title> import for you to review and confirm", how many rows are ready and how many need attention, and the main reasons in plain words. Never list rows or values: the card shows them.';

export type PrepareImportRun=Readonly<{ok:boolean;content:unknown;refusal?:string;proposal?:Proposal}>;
const optionsOf=(kinds:readonly ChatImportKindInfo[])=>Object.freeze(kinds.map((row,index)=>Object.freeze({option:index+1,kind:row.kind,title:row.title,
 ...(row.linkablePage?{page:row.linkablePage}:{}),template:row.template!==null})));

export async function runPrepareImport(ctx:SessionContext,kinds:readonly ChatImportKindInfo[],input:Readonly<Record<string,unknown>>,
 scope:Readonly<{companyId:string;personWords?:string;importFile?:ChatImportFile}>):Promise<PrepareImportRun>{
 if(!scope.importFile)return{ok:false,refusal:'file_needed',content:{ok:false,refusal:'file_needed',options:optionsOf(kinds),note:FILE_NOTE}};
 const resolved=resolveChatImportKind(kinds,{choice:input.choice,requested:input.kind,personWords:scope.personWords,headerText:scope.importFile.text});
 if(resolved.kind==='unclear')return{ok:false,refusal:'missing_details',content:{ok:false,refusal:'missing_details',options:optionsOf(kinds),note:ASK_NOTE}};
 const info=resolved.info,named={kind:info.kind,title:info.title};
 const prepared=await prepareChatImportProposal(ctx,{info,companyId:scope.companyId,file:scope.importFile});
 if(prepared.kind==='wrong_format')return{ok:false,refusal:'wrong_format',content:{ok:false,refusal:'wrong_format',...named,formats:[...info.formats],note:FORMAT_NOTE}};
 if(prepared.kind==='not_permitted')return{ok:false,refusal:'not_permitted',content:{ok:false,refusal:'not_permitted',...named,note:NOT_PERMITTED_NOTE}};
 if(prepared.kind==='unreadable')return{ok:false,refusal:'unreadable',content:{ok:false,refusal:'unreadable',...named,...(info.linkablePage?{page:info.linkablePage}:{}),note:UNREADABLE_NOTE}};
 const {preview,proposal}=prepared;
 return{ok:true,proposal,content:{ok:true,...named,company:proposal.body.import!.company,rows:preview.total,ready:preview.ready,attention:preview.attention,
  reasons:issueCounts(preview.issues),revertible:info.revertible,confirmable:preview.confirmable,note:PREPARED_NOTE}};
}
