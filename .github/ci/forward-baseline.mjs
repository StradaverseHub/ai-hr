/** Source-only forward staging compatibility. Never changes a CI receipt's recorded baseline. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {appliedMigrationIdentity} from './migration-history.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
export function forwardBaselineSource({repository,candidate,ciBaseline,deploymentBaseline}){
 for(const sha of [candidate,ciBaseline,deploymentBaseline])assert(/^[a-f0-9]{40}$/.test(sha??''),'Exact baseline commit identities required');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{maxBuffer:32*1024**2,timeout:10000});
 for(const ref of [candidate,ciBaseline,deploymentBaseline])assert(git('cat-file','-t',ref).toString().trim()==='commit','Baseline identity is not a commit');
 for(const [base,head] of [[ciBaseline,deploymentBaseline],[deploymentBaseline,candidate]])git('merge-base','--is-ancestor',base,head);
 const source=ref=>{const j=JSON.parse(git('show',ref+':db/migrations/meta/_journal.json')).entries;assert(Array.isArray(j)&&j.length>0&&j.length<=10000,'Bounded complete baseline journal required');const seen=new Set();return j.map(row=>{assert(/^[A-Za-z0-9_-]{1,160}$/.test(row.tag??'')&&!seen.has(row.tag)&&Number.isSafeInteger(row.when)&&row.when>0,'Unique safe exact migration identity required');seen.add(row.tag);const bytes=git('show',ref+':db/migrations/'+row.tag+'.sql');assert(bytes.length>0&&bytes.length<=16*1024**2,'Bounded immutable SQL required');return {journal:row,sourceHash:installHash(bytes),ledger:{tag:row.tag,created_at:String(row.when),...appliedMigrationIdentity(row.tag,row.when,bytes)}};});};
 const before=source(ciBaseline),deployed=source(deploymentBaseline),after=source(candidate);
 const exact=(older,newer)=>older.length<=newer.length&&older.every((row,i)=>isDeepStrictEqual(row.journal,newer[i].journal)&&row.sourceHash===newer[i].sourceHash);
 assert(exact(before,deployed)&&exact(deployed,after),'Baseline journal/SQL is not an unchanged ordered prefix');
 const tree=ref=>git('rev-parse',ref+'^{tree}').toString().trim();
 const body={format:1,kind:'FORWARD_STAGING_BASELINE_SOURCE_PREFIX_NOT_CI_RECEIPT',candidate,ciBaseline,deploymentBaseline,ciTree:tree(ciBaseline),deploymentTree:tree(deploymentBaseline),candidateTree:tree(candidate),ciMigrationCount:before.length,deploymentMigrationCount:deployed.length,candidateMigrationCount:after.length,ciSourceIdentity:installHash(installJson(before)),deploymentSourceIdentity:installHash(installJson(deployed)),deploymentLedger:deployed.map(row=>row.ledger),originalCiBaselinePreserved:true,requiresFreshActualLedgerAndBuildBinding:true,requiresOriginalCIAuthentication:true,releaseAuthorized:false};
 return {...body,proofSha256:installHash(installJson(body))};
}
