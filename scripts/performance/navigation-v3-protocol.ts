/** V3 intent grammar only. Parsing never proves identity, authority or execution. */
import {z} from 'zod';
import {PERSONNEL_RECORD_TAB_DEFINITIONS,ESS_PROFILE_TAB_DEFINITIONS} from '../../lib/personnel-record-navigation';
import {DRAFT_TAB_DEFINITIONS} from '../../lib/employee-draft-schema';

export const NAVIGATION_V3_PROTOCOL='aihr-navigation-development/v3-intent' as const;
export const NAVIGATION_V3_LIMITS=Object.freeze({scenarioMs:90000,scenarios:1024,steps:8,checks:16,steadyUsers:500,realSignIns:4,loadedContexts:6});
export const NAVIGATION_V3_ROLES=['employee','manager','companyHR','groupHR']as const;
export type NavigationV3Role=typeof NAVIGATION_V3_ROLES[number];
export const NAVIGATION_V3_FIRST_FAMILIES=['personnel-record','personnel-draft','self-profile']as const;
export type NavigationV3FirstFamily=typeof NAVIGATION_V3_FIRST_FAMILIES[number];
export const NAVIGATION_V3_FIRST_CHOICES=Object.freeze([
 ...PERSONNEL_RECORD_TAB_DEFINITIONS.map(tab=>Object.freeze({family:'personnel-record' as const,id:tab.navigationId,key:tab.key,owner:'lib/personnel-record-navigation.ts'})),
 ...DRAFT_TAB_DEFINITIONS.map(tab=>Object.freeze({family:'personnel-draft' as const,id:tab.navigationId,key:tab.key,owner:'lib/employee-draft-schema.ts'})),
 ...ESS_PROFILE_TAB_DEFINITIONS.map(tab=>Object.freeze({family:'self-profile' as const,id:tab.navigationId,key:tab.key,owner:'lib/personnel-record-navigation.ts'})),
]);
const employmentRelations=['own-current','permitted-report','allowed-other-company','historical','foreign-tenant','same-tenant-out-of-scope','nonexistent']as const;
const draftRelations=['own-reserved-draft','allowed-other-company','foreign-tenant','same-tenant-out-of-scope','nonexistent']as const;
const ownRelations=['own-current','historical','foreign-tenant','same-tenant-other-person','nonexistent']as const;
const record=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('workforce-employment'),relation:z.enum(employmentRelations)}).strict(),
 z.object({kind:z.literal('draft'),relation:z.enum(draftRelations)}).strict(),
 z.object({kind:z.literal('own-employment'),relation:z.enum(ownRelations)}).strict(),
]);
const intent=z.object({
 id:z.string().regex(/^v3\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,220}(?![\s\S])/),
 family:z.enum(NAVIGATION_V3_FIRST_FAMILIES),destinationId:z.string().min(1).max(256),
 fixtureRole:z.enum(NAVIGATION_V3_ROLES),record,
 interaction:z.enum(['read','draft-unsaved-cancel','draft-unsaved-discard','draft-save-reopen']),
}).strict();
const request=z.object({protocol:z.literal(NAVIGATION_V3_PROTOCOL),scope:z.literal('first-record-contract-unadmitted'),intents:z.array(intent).min(1).max(NAVIGATION_V3_LIMITS.scenarios)}).strict();
export type NavigationV3Intent=z.infer<typeof intent>;
export type NavigationV3Request=z.infer<typeof request>;
export function freezeNavigationV3Value<T>(value:T):Readonly<T>{
 if(value!==null&&typeof value==='object'){for(const item of Object.values(value))freezeNavigationV3Value(item);Object.freeze(value);}
 return value;
}
export function navigationV3Choice(value:Pick<NavigationV3Intent,'family'|'destinationId'>){
 const choice=NAVIGATION_V3_FIRST_CHOICES.find(item=>item.family===value.family&&item.id===value.destinationId);
 if(!choice)throw Error('Uncomposed or mismatched v3 canonical choice');return choice;
}
/** The fixture role and symbolic relation express an obligation, never an allow/deny policy. */
export function parseNavigationV3Request(value:unknown):Readonly<NavigationV3Request>{
 if(!value||typeof value!=='object'||Array.isArray(value)||!('intents'in value)||!Array.isArray(value.intents)||value.intents.length<1||value.intents.length>NAVIGATION_V3_LIMITS.scenarios)throw Error('Bounded v3 intention array required');
 const parsed=request.parse(value),ids=new Set<string>(),obligations=new Set<string>();
 for(const row of parsed.intents){
  const choice=navigationV3Choice(row);
  if(row.record.kind!==(row.family==='personnel-record'?'workforce-employment':row.family==='personnel-draft'?'draft':'own-employment'))throw Error('V3 family and record type differ');
  if(row.interaction!=='read'&&(row.family!=='personnel-draft'||choice.key!=='profile'||row.record.relation!=='own-reserved-draft'))throw Error('Unreviewed v3 mutation interaction');
  const key=JSON.stringify([row.family,row.destinationId,row.fixtureRole,row.record.kind,row.record.relation,row.interaction]);
  if(ids.has(row.id)||obligations.has(key))throw Error('Duplicate v3 case or obligation');ids.add(row.id);obligations.add(key);
 }
 return freezeNavigationV3Value(parsed);
}
