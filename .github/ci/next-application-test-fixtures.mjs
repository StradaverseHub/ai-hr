/** Synthetic graph/provenance for private protocol probes, never actual compiler/build evidence. */
import {buildPacketFixture,fixtureHash} from './build-artifact-test-fixture.mjs';
export function applicationStateFixture(expected={}){
 const packet=buildPacketFixture(expected),p=packet.provenance,e=packet.expected,digest='a'.repeat(64);
 const inputs=['tsconfig.json','tsconfig.build.json','pnpm-lock.yaml','package.json','pnpm-workspace.yaml','next.config.ts','deploy/css-cache-guard.sh','cssInputs'];
 const binaries=['typescript/package.json','typescript/lib/tsc.js','typescript/lib/_tsc.js','typescript/lib/typescript.js','next/dist/lib/typescript/runTypeCheckCli.js','next/dist/lib/typescript/runTypeScriptCli.js','next/dist/lib/typescript/runTypeCheck.js','next/dist/build/type-check.js'];
 const context={runtime:{...p.runtime,typescript:'5.9.3'},sourcePath:'/home/runner/work/ai-hr/ai-hr/source',nodeOptions:'--max-old-space-size=6144',
  inputs:Object.fromEntries(inputs.map(k=>[k,digest])),compiler:Object.fromEntries(binaries.map(k=>[k,digest])),generatedTypes:[{path:'validator.ts',bytes:12,sha256:digest}]};
 const state=Buffer.from(JSON.stringify({version:'5.9.3',fileNames:['../../app/(app)/page.tsx','../../lib/dependency.ts']}));
 const text='Compiled successfully in fixture\nFinished TypeScript in fixture\n';
 const producer={kind:'CANONICAL_CI_APPLICATION_COMPILER_STATE_NOT_RELEASE',releaseAuthorized:false,exitCode:0,source:p.source,controller:p.controller,runId:String(p.runId),attempt:'1',
  sourceRestored:true,controllerRestored:true,workingStateRemoved:true,ownedRecordsRemoved:true,cachePublishPermitted:true,buildLogSha256:fixtureHash(Buffer.from(text)),
  actualCanonicalBuild:{code:0,signal:null,timedOut:false,startedAt:e.producerStartedAt,endedAt:e.producerCompletedAt}};
 const envelope={kind:'NEXT_APPLICATION_COMPILER_STATE_BUILD_MUST_RUN',releaseAuthorized:false,source:p.source,controller:p.controller,runId:String(p.runId),attempt:'1',context,
  completedCommand:'canonical-build',completedCommandExit:0,completedAt:e.producerCompletedAt,bytes:state.length,sha256:fixtureHash(state),files:2,nextBuildId:p.nextBuildId,buildRecordId:p.buildRecordId};
 const files=new Map(['build-provenance.json','system-testing.json','successful-build.json'].map(name=>[name,packet.entries[name]]));
 for(const [name,value]of Object.entries({'producer.json':producer,'envelope.json':envelope,'build-log.json':{kind:'RAW_CANONICAL_NEXT_BUILD_OUTPUT',text}}))files.set(name,Buffer.from(JSON.stringify(value)));
 files.set('state.json',state);
 return {files,producer,envelope,context,expected:e,run:{id:p.runId,head_sha:p.controller},job:{started_at:e.producerStartedAt,completed_at:e.producerCompletedAt},now:Date.parse(e.producerCompletedAt)+1000};
}
