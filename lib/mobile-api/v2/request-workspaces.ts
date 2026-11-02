import {z} from 'zod';
import {commandOf} from './common';
import {TaskDecisionRefusal,TaskDocumentRefusal} from './tasks';
export {TaskDocumentRefusal};
export const RequestWorkspaceKind=z.enum(['profile','resignation','noticeAcknowledgement']);
export type RequestWorkspaceKind=z.infer<typeof RequestWorkspaceKind>;
export const isRequestWorkspaceKind=(s:string):s is RequestWorkspaceKind=>RequestWorkspaceKind.safeParse(s).success;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validRequestReference(kind:RequestWorkspaceKind,id:string){if(kind!=='noticeAcknowledgement')return UUID.test(id);const p=id.split(':');return p.length===3&&UUID.test(p[0])&&UUID.test(p[1])&&/^[1-9][0-9]{0,9}$/.test(p[2]);}
const document=z.object({ref:z.string().min(1).max(128),name:z.string().max(300)});
const common={id:z.string().min(1).max(128),subject:z.string().max(300),code:z.string().max(64).nullable().optional(),documents:z.array(document).max(50),expected:z.object({digest:z.string().regex(/^[0-9a-f]{64}$/)})};
export const RequestWorkspace=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('profile'),lines:z.array(z.object({key:z.string().max(300),label:z.string().max(1000),record:z.string().max(1000).nullable(),before:z.string().max(100000),after:z.string().max(100000)})).max(500)}),
 z.object({...common,kind:z.literal('resignation'),lastWorkingDay:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),reason:z.string().max(100000).nullable()}),
 z.object({...common,kind:z.literal('noticeAcknowledgement'),body:z.string().max(500000),contentVersion:z.number().int().positive(),publishedBy:z.string().max(300).nullable(),publishedAt:z.string().nullable(),startOn:z.string(),endOn:z.string().nullable()}),
]);
export type RequestWorkspace=z.infer<typeof RequestWorkspace>;
export const RequestWorkspaceResult=z.union([z.object({outcome:z.literal('found'),workspace:RequestWorkspace}),TaskDecisionRefusal]);
export type RequestWorkspaceResult=z.infer<typeof RequestWorkspaceResult>;
export const RequestWorkspaceCommand=commandOf({action:z.enum(['approve','reject','acknowledge']),reason:z.string().trim().max(1000).optional(),expected:z.object({digest:z.string().regex(/^[0-9a-f]{64}$/)}).strict()});
export type RequestWorkspaceCommand=z.infer<typeof RequestWorkspaceCommand>;
export const RequestWorkspaceDecisionResult=z.union([z.object({outcome:z.literal('accepted'),status:z.enum(['approved','rejected','accepted','acknowledged'])}),TaskDecisionRefusal]);
