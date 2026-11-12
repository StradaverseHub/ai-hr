/** 96a54ed2 — Request On Behalf and Approve On Behalf, declared in the semantic model so a person who may act on behalf
 * can ask about those two pages in chat (definition of done for /attendance/on-behalf/request and /approve: their
 * semantic entry and corpus turn). Owner decision of 12 November 2026 ("Approve, ship B after").
 *
 * Two reads, served as operations_status topics of the same names (no new provider tool), each over its page's own read
 * owners run as the caller under tenant row-level security (core/explainers/attendance-on-behalf.ts):
 *  - attendance_on_behalf_subjects: the first page of employees the caller may file an attendance request for, exactly as
 *    the Request On Behalf page lists them (packs/attendance/service searchAttendanceOnBehalfSubjects, purpose request);
 *  - attendance_on_behalf_approvers: the first page of designated approvers the caller may decide for, exactly as the
 *    Approve On Behalf page lists them (the same owner, purpose approve).
 * Who may be listed is the page's own decision: the caller holds attendance.request_on_behalf / approve_on_behalf for
 * the person's company, and the person is in a company the caller administers as HR or beneath one of the caller's own
 * employments in the administrative reporting line. A caller without the key is refused before anything is read.
 *
 * Disclosure (owner approval, 12 November 2026): a person's name is `minimum` of type name, so it always leaves as an
 * opaque placeholder restored locally; company, department and position are `minimum` labels; employment ids and
 * employee codes are never read into the result. Read only: filing and deciding on behalf stay human-only actions on the
 * pages, and no action is declared here. Pure declarations; nothing here reads or grants. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const ATTENDANCE_REQUEST_ON_BEHALF_PAGE='/attendance/on-behalf/request';
export const ATTENDANCE_APPROVE_ON_BEHALF_PAGE='/attendance/on-behalf/approve';

const people=(meaning:string)=>f('people','list','minimum',meaning,{of:[
 f('name','name','minimum','The person\'s name. Always a placeholder restored for the reader.'),
 f('company','label','minimum','The company the person works for.'),
 f('department','label','minimum','The person\'s current department; null when none is recorded.'),
 f('position','label','minimum','The person\'s current position; null when none is recorded.')]});
const more=f('more','boolean','full','True when the page lists more people than this first page; the rest are found by searching on the page.');
const owners=['core/attendance-on-behalf.ts#canActOnBehalf','core/attendance-on-behalf.ts#searchAttendanceOnBehalfSubjects'] as const;

export const ATTENDANCE_ON_BEHALF_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'attendance_on_behalf_subject',label:'Request On Behalf employees',
  meaning:'For people who may file attendance requests for others: the employees listed on Attendance › Request On Behalf, the ones this person may file an Attendance Irregularity or Self Overtime request for. They are employees of companies the person administers as HR, or people beneath them in their own reporting line, and only where the person holds the request-on-behalf permission. A request filed for someone follows that employee\'s own approval workflow.',
  module:'attendance',sensitivity:'ordinary',audience:'admin',rls:'visible_employments',owners:[...owners],
  ruleVersion:null,relations:[],page:ATTENDANCE_REQUEST_ON_BEHALF_PAGE,
  fields:[people('One row per employee, in the page\'s own order (Employee ID, then name). Empty when there is nobody to list.'),more,provenanceField]},
 {id:'attendance_on_behalf_approver',label:'Approve On Behalf approvers',
  meaning:'For people who may decide attendance requests for others: the designated approvers listed on Attendance › Approve On Behalf, the ones whose waiting Attendance Irregularity and Self Overtime requests this person may approve or reject for them. They are approvers in companies the person administers as HR, or people beneath them in their own reporting line, and only where the person holds the approve-on-behalf permission. A decision made for someone is recorded as made on their behalf.',
  module:'attendance',sensitivity:'ordinary',audience:'admin',rls:'visible_employments',owners:[...owners],
  ruleVersion:null,relations:[],page:ATTENDANCE_APPROVE_ON_BEHALF_PAGE,
  fields:[people('One row per designated approver, in the page\'s own order (Employee ID, then name). Empty when there is nobody to list.'),more,provenanceField]},
] satisfies SemanticEntity[]);

export const ATTENDANCE_ON_BEHALF_READS:readonly SemanticRead[]=freeze([
 {name:'attendance_on_behalf_subjects',entity:'attendance_on_behalf_subject',
  purpose:'Only for people who may file attendance requests for others: the employees this person may file an Attendance Irregularity or Self Overtime request for, as the first page of Attendance › Request On Behalf lists them, with each one\'s company, department and position. Read only: requests are filed on that page, by the person, never here.',
  input:[]},
 {name:'attendance_on_behalf_approvers',entity:'attendance_on_behalf_approver',
  purpose:'Only for people who may decide attendance requests for others: the designated approvers this person may approve or reject waiting attendance requests for, as the first page of Attendance › Approve On Behalf lists them, with each one\'s company, department and position. Read only: decisions are made on that page, by the person, never here.',
  input:[]},
] satisfies SemanticRead[]);
