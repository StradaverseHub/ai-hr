/** AI v2 Phase 1, slice 3 (issue 16b) — an import prepared in chat, declared in the semantic model.
 *
 * The harness's `prepare_import` result (core/chat-import/tool.ts) is disclosed under this entity. It is all the model
 * learns about an attached file: which kind of import it is, how many rows are ready and how many need attention, and
 * why, in a closed vocabulary (lib/chat-import.ts). The file itself, its name, its cells and the owner's own sentences
 * never reach it.
 *  - row counts are `bands`: a placeholder and its band, restored locally for the person;
 *  - the company is `minimum`: the administrator's own company label (configuration they administer);
 *  - kinds, titles, pages, formats and reasons are product vocabulary (`full`).
 * An undeclared key is removed (fail closed). Pure declarations; nothing here reads or grants. */
import {CHAT_IMPORT_ISSUES,CHAT_IMPORT_KINDS} from '../../lib/chat-import';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

const kind=f('kind','enum','full','Which import: employee records, leave balances, payroll history or attendance clockings.',{values:CHAT_IMPORT_KINDS});
export const IMPORT_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'chat_import',label:'An import prepared in chat',
  meaning:'An import the signed-in administrator can prepare from a file attached in chat: the import owner previews the file as them, and the result is a card they confirm. Only counts and kinds of issue are here, never the file.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/proposals/chat-import.ts#prepareChatImportProposal','core/chat-import/kinds.ts#chatImportKindsFor'],
  ruleVersion:null,relations:[],page:'/assistant',
  fields:[
   f('options','list','full','The imports this person can prepare here, numbered in a fixed order.',{of:[
    f('option','integer','full','Its number in this list.'),kind,f('title','label','full','Its plain title.'),
    f('page','label','full','Its import page.'),f('template','boolean','full','The import page offers a template.'),
   ]}),
   kind,f('title','label','full','The plain title of the import.'),f('page','label','full','Its import page.'),
   f('formats','list','full','The file types this import takes.'),
   f('company','label','minimum','The company it imports into, one this administrator administers.'),
   f('rows','integer','bands','Data rows in the file.'),
   f('ready','integer','bands','Rows that are imported when the person confirms.'),
   f('attention','integer','bands','Rows that need the person\'s attention and are not imported.'),
   f('reasons','list','full','Why rows need attention, by kind of issue.',{of:[
    f('reason','enum','full','The kind of issue.',{values:CHAT_IMPORT_ISSUES}),f('rows','integer','bands','Rows with this issue.'),
   ]}),
   f('revertible','boolean','full','The whole import can be reverted afterwards from its history.'),
   f('confirmable','boolean','full','The rows that are ready can be imported now; when false, every row must be fixed first on the import page.'),
  ]},
] satisfies SemanticEntity[]);
