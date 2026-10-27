/** Source-only forward staging compatibility. Never changes a CI receipt's recorded baseline. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {appliedMigrationIdentity} from './migration-history.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
/** Read immutable migration bytes in one bounded batch, with exact regular-file identities. */
export function readMigrationTrees(repository,refs){
 assert(Array.isArray(refs)&&refs.length>0&&refs.length<=3&&refs.every(ref=>/^[a-f0-9]{40}$/.test(ref)),'Exact bounded migration refs required');
 const paths=new Map(),ids=new Set();
 for(const ref of new Set(refs)){
  const raw=execFileSync('git',['-C',repository,'ls-tree','-r','-z',ref,'--','db/migrations'],{maxBuffer:8*1024**2,timeout:10000});
  const entries=new Map();
  for(const record of raw.toString('utf8').split('\0').filter(Boolean)){
   const m=/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(record);
   assert(m,'Malformed immutable migration tree');
   if(m[4]!=='db/migrations/meta/_journal.json'&&!/^db\/migrations\/[A-Za-z0-9_-]{1,160}\.sql$/.test(m[4]))continue;
   assert(['100644','100755'].includes(m[1])&&m[2]==='blob'&&!entries.has(m[4]),'Migration input must be a unique regular blob');
   entries.set(m[4],m[3]);ids.add(m[3]);
  }
  assert(entries.size>0&&entries.size<=10001,'Bounded complete migration tree required');paths.set(ref,entries);
 }
 assert(ids.size>0&&ids.size<=30003,'Bounded migration object inventory required');
 const ordered=[...ids],bytes=execFileSync('git',['-C',repository,'cat-file','--batch'],{input:ordered.join('\n')+'\n',maxBuffer:64*1024**2,timeout:10000}),blobs=new Map();let offset=0;
 for(const id of ordered){
  const end=bytes.indexOf(10,offset);assert(end>=offset,'Truncated migration object header');
  const header=bytes.subarray(offset,end).toString('utf8').split(' '),size=Number(header[2]);
  assert(header.length===3&&header[0]===id&&header[1]==='blob'&&Number.isSafeInteger(size)&&size>0&&size<=16*1024**2,'Bounded exact migration blob required');offset=end+1;
  assert(offset+size<bytes.length&&bytes[offset+size]===10,'Truncated migration object bytes');blobs.set(id,bytes.subarray(offset,offset+size));offset+=size+1;
 }
 assert(offset===bytes.length,'Unexpected migration object suffix');
 return new Map([...paths].map(([ref,entries])=>[ref,new Map([...entries].map(([path,id])=>[path,blobs.get(id)]))]));
}
export function forwardBaselineSource({repository,candidate,ciBaseline,deploymentBaseline}){
 for(const sha of [candidate,ciBaseline,deploymentBaseline])assert(/^[a-f0-9]{40}$/.test(sha??''),'Exact baseline commit identities required');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{maxBuffer:32*1024**2,timeout:10000});
 for(const ref of [candidate,ciBaseline,deploymentBaseline])assert(git('cat-file','-t',ref).toString().trim()==='commit','Baseline identity is not a commit');
 for(const [base,head] of [[ciBaseline,deploymentBaseline],[deploymentBaseline,candidate]])git('merge-base','--is-ancestor',base,head);
 const trees=readMigrationTrees(repository,[ciBaseline,deploymentBaseline,candidate]);
 const source=ref=>{const files=trees.get(ref),journal=files.get('db/migrations/meta/_journal.json');assert(journal,'Complete immutable journal required');const j=JSON.parse(journal).entries;assert(Array.isArray(j)&&j.length>0&&j.length<=10000,'Bounded complete baseline journal required');const seen=new Set();return j.map(row=>{assert(/^[A-Za-z0-9_-]{1,160}$/.test(row.tag??'')&&!seen.has(row.tag)&&Number.isSafeInteger(row.when)&&row.when>0,'Unique safe exact migration identity required');seen.add(row.tag);const bytes=files.get('db/migrations/'+row.tag+'.sql');assert(bytes&&bytes.length>0&&bytes.length<=16*1024**2,'Bounded immutable SQL required');return {journal:row,sourceHash:installHash(bytes),ledger:{tag:row.tag,created_at:String(row.when),...appliedMigrationIdentity(row.tag,row.when,bytes)}};});};
 const before=source(ciBaseline),deployed=source(deploymentBaseline),after=source(candidate);
 const exact=(older,newer)=>older.length<=newer.length&&older.every((row,i)=>isDeepStrictEqual(row.journal,newer[i].journal)&&row.sourceHash===newer[i].sourceHash);
 assert(exact(before,deployed)&&exact(deployed,after),'Baseline journal/SQL is not an unchanged ordered prefix');
 const tree=ref=>git('rev-parse',ref+'^{tree}').toString().trim();
 const body={format:1,kind:'FORWARD_STAGING_BASELINE_SOURCE_PREFIX_NOT_CI_RECEIPT',candidate,ciBaseline,deploymentBaseline,ciTree:tree(ciBaseline),deploymentTree:tree(deploymentBaseline),candidateTree:tree(candidate),ciMigrationCount:before.length,deploymentMigrationCount:deployed.length,candidateMigrationCount:after.length,ciSourceIdentity:installHash(installJson(before)),deploymentSourceIdentity:installHash(installJson(deployed)),deploymentLedger:deployed.map(row=>row.ledger),originalCiBaselinePreserved:true,requiresFreshActualLedgerAndBuildBinding:true,requiresOriginalCIAuthentication:true,releaseAuthorized:false};
 return {...body,proofSha256:installHash(installJson(body))};
}
