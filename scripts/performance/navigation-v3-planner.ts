/** Pure schedule intentions + fixed source census. No runtime receipt or authority. */
import {openSync,closeSync,constants,fstatSync,lstatSync,readSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {navigationV3Choice,parseNavigationV3Request,freezeNavigationV3Value,NAVIGATION_V3_ROLES,NAVIGATION_V3_LIMITS} from './navigation-v3-protocol';
import {navigationV3CommissioningStatus} from './navigation-v3-admission';
const CENSUS_PATH='../../docs/qualification/nested-navigation-owner-inventory-20261108.json';
export const NAVIGATION_V3_CENSUS_SHA256='746d8bbf9130588a91801d2b54983821cdf60cc5e4e748c908cc727e5cb3b930';
const census=z.object({families:z.array(z.object({id:z.string().min(1)})).length(46),parameterizedPageCensus:z.array(z.object({source:z.string().min(1),realm:z.enum(['hr','operator','invitation']),parameterNames:z.array(z.string().min(1))})).length(120)});
function sourceCensus(){
 const path=new URL(CENSUS_PATH,import.meta.url),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bytes:Buffer;
 try{
  const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size<1||before.size>2*1024*1024)throw Error('Bounded fixed v3 census required');
  bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const read=readSync(fd,bytes,offset,bytes.length-offset,offset);if(read<1)throw Error('V3 census truncated');offset+=read;}
  if(readSync(fd,Buffer.alloc(1),0,1,offset)!==0)throw Error('V3 census grew');
  const after=fstatSync(fd),named=lstatSync(path);if(named.isSymbolicLink())throw Error('V3 census path changed');
  for(const field of ['dev','ino','nlink','size','mtimeMs','ctimeMs']as const)if(before[field]!==after[field]||after[field]!==named[field])throw Error('V3 census changed during read');
 }finally{closeSync(fd);}
 if(createHash('sha256').update(bytes).digest('hex')!==NAVIGATION_V3_CENSUS_SHA256)throw Error('Fixed v3 census source changed; review required');
 const parsed=census.parse(JSON.parse(bytes.toString('utf8')));
 if(new Set(parsed.families.map(row=>row.id)).size!==46||new Set(parsed.parameterizedPageCensus.map(row=>row.source)).size!==120)throw Error('V3 census identities differ');
 return parsed;
}
export function compileNavigationV3Plan(value:unknown){
 const request=parseNavigationV3Request(value),source=sourceCensus(),commission=navigationV3CommissioningStatus();
 const cases=request.intents.map(intent=>{
  const choice=navigationV3Choice(intent);
  // No free selector, URL, path, query, script or expected native outcome can be supplied.
  const steps=intent.interaction==='read'
   ?['resolve-native-record','follow-canonical-record-entry','choose-visible-canonical-panel','assert-active-usable-content']as const
   :['resolve-native-record','follow-canonical-record-entry','choose-visible-canonical-panel','edit-owned-draft-phone','invoke-native-dirty-or-save-control','assert-persistence-and-active-content']as const;
  if(steps.length>NAVIGATION_V3_LIMITS.steps)throw Error('V3 step capacity exceeded');
  return {...intent,descriptorOwner:choice.owner,canonicalKey:choice.key,steps,
   nativeDisposition:'unresolved' as const,contentOracle:'unreviewed' as const,
   execution:'not-executed' as const,admission:commission.kind};
 });
 const families=source.families.map(family=>({id:family.id,roles:NAVIGATION_V3_ROLES.map(role=>({role,
  proposedCases:cases.filter(row=>row.family===family.id&&row.fixtureRole===role).map(row=>row.id),
  nativeDisposition:'unresolved' as const,baseline:'not-executed' as const,loaded:'not-executed' as const,
 }))}));
 return freezeNavigationV3Value({protocol:request.protocol,scope:request.scope,censusSha256:NAVIGATION_V3_CENSUS_SHA256,
  families,parameterizedPages:source.parameterizedPageCensus.map(page=>({...page,descriptorAssociation:'unresolved' as const,
   nativeBinding:'unbound' as const,execution:'not-executed' as const})),cases,
  capacity:{scenarioTimeoutMs:NAVIGATION_V3_LIMITS.scenarioMs,maximumCases:NAVIGATION_V3_LIMITS.scenarios,
   stepsPerCase:NAVIGATION_V3_LIMITS.steps,checksPerCase:NAVIGATION_V3_LIMITS.checks,roleMatrixComplete:false as const,
   steady500ScheduleFits:'not-proven' as const,cohortAssignment:'not-reviewed' as const},
  commissioning:commission,sourceMatrixComplete:false as const,runtimeAcceptance:false as const,releaseAuthorized:false as const,
 });
}
