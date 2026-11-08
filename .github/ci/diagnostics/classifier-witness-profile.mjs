/** Closed source facts only. No process, I/O, admission or execution authority. */
const freezeRows=rows=>Object.freeze(rows.map(row=>Object.freeze(row)));
const profile='linux-owned-classifier-witness-v1';
export const CLASSIFIER_WITNESS_PROFILES=freezeRows([
 {owner:'classifier',purpose:'semantic',file:'test/gate-db-classifier-semantic-witness.test.ts',profile,job:'classifier-semantic'},
 {owner:'classifier',purpose:'cli-b',file:'test/gate-db-classifier-cli-b.test.ts',profile,job:'classifier-cli'},
 {owner:'classifier',purpose:'cli-c',file:'test/gate-db-classifier-cli-c.test.ts',profile,job:'classifier-cli'},
]);
export const CLASSIFIER_WITNESS_FILES=Object.freeze(CLASSIFIER_WITNESS_PROFILES.map(row=>row.file));
export const classifierWitnessFile=file=>CLASSIFIER_WITNESS_PROFILES.find(row=>row.file===file)??null;
/** A malformed capability for a known selector refuses; it cannot disappear as an unrelated unit. */
export function classifierWitnessUnit(unit){
 const files=unit?.files,known=Array.isArray(files)&&files.some(file=>classifierWitnessFile(file));
 if(!known)return false;
 const descriptor=unit.singleton;
 if(files.length!==1||!classifierWitnessFile(files[0])||unit.kind!=='nodb'||!descriptor
  ||Object.keys(descriptor).sort().join('|')!=='isolation|profile|version|workers'
  ||descriptor.version!==1||descriptor.profile!==profile||descriptor.workers!==1||descriptor.isolation!=='job-host')throw Error('Classifier singleton capability refused');
 return true;
}
export const CLASSIFIER_WITNESS_TIMING=Object.freeze({jobMs:1800000,preAnchorMs:30000,artifactTailMs:120000,jobSettlementMs:6000,caseMs:450000,admissionMs:10000,ownerMs:420000,assertionTailMs:20000,preparationMs:30000,ownerCloseMs:6000});
const pre=['source-head','source-status','all-tracked','controller-head','controller-status'];
const post=pre.map(stage=>'post-'+stage);
const phase=(stage,workMs)=>({stage,workMs,settlementMs:6000});
export const CLASSIFIER_WITNESS_PHASES=Object.freeze({
 semantic:freezeRows([...pre.map(stage=>phase(stage,10000)),phase('collect',15000),phase('replay',15000),...post.map(stage=>phase(stage,10000)),phase('seal',10000)]),
 'cli-b':freezeRows([...pre.map(stage=>phase(stage,10000)),phase('parent-auth',120000),phase('prepare',15000),phase('cli',15000),phase('postimage',15000),...post.map(stage=>phase(stage,10000)),phase('seal',10000)]),
 'cli-c':freezeRows([...pre.map(stage=>phase(stage,10000)),phase('parent-auth',120000),phase('prepare',15000),phase('cli',15000),phase('postimage',15000),...post.map(stage=>phase(stage,10000)),phase('seal',10000)]),
});
export const CLASSIFIER_WITNESS_BYTES=Object.freeze({inventory:8*1024**2,input:8*1024**2,output:16*1024**2,smallMember:1024**2,largeMember:16*1024**2,ledger:131072,ledgerRows:128,ledgerRow:1024,archiveMembers:100,archiveMember:64*1024**2,expanded:128*1024**2,zip:64*1024**2});
export const CLASSIFIER_WITNESS_DIRECTORY='classifier-witness';
export const CLASSIFIER_PROGRAMS=Object.freeze({
 a:Object.freeze({sha256:'cc77445ba5b8a702a5f8f4a4292bdcb99275d520ae4f13b16442a17e78f3f916',source:'42aef592777b713a9d218f4ba94522e8249ccbb7'}),
 b:Object.freeze({sha256:'3ea38a9643463dc23bf7e5c65dc5386e5e7e33ef2e22f5f7d09f5c3da924dfb2',source:'ec1853d99a56b15ed90d3eacfaf8d1454dfd4eba'}),
 c:Object.freeze({sha256:'2a8c7a347ffc0ac6c090de12def4c8f6f3a055db2780f90d7fdf596e4c76b654',source:'c5e36cb03095527ba1fb6a0e8fc2bf54080f2c46'}),
});
