/** Static private plan generation only. Reads captured config; never connects, installs or enables trust. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hardenProxyConfig,renderIngressHttp} from './ingress-policy.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function createMaintenancePlan(baseline,manifest,{workerBefore,buildId,publicOrigin}){
 assert(manifest.kind==='PROTECTED_EMAIL_SECURITY_ARTIFACT_NOT_INSTALLED'&&manifest.agent.nodemailer==='10.1.4'&&manifest.agent.retainsLettersHold===true&&manifest.runtime.node==='22.23.3'&&manifest.runtime.modules==='127'&&manifest.runtime.platform==='linux'&&manifest.runtime.arch==='x64');
 assert(/^[a-f0-9]{40}$/.test(manifest.source)&&/^[a-f0-9]{64}$/.test(workerBefore)&&/^[A-Za-z0-9_-]{1,160}$/.test(buildId));
 const files=[];
 for(const name of ['/etc/nginx/conf.d/aihr-sfm.conf','/etc/nginx/conf.d/zz-aihr-onehr-staging.conf','/etc/nginx/sites-enabled/aihr-identity']){
  const rows=baseline.nginxFiles.filter(f=>f.path===name);assert.equal(rows.length,1);const row=rows[0];assert(row.uid===0&&row.mode==='0o644'&&hash(row.text)===row.sha256);
  const expected=name.includes('sites-enabled')?'/etc/nginx/sites-available/aihr-identity':name;assert.equal(row.realpath,expected);
  const text=hardenProxyConfig(row.text,{publicEdge:!name.includes('sites-enabled')});files.push({path:expected,before:row.sha256,after:hash(text),base64:Buffer.from(text).toString('base64')});
 }
 const http=renderIngressHttp();files.push({path:'/etc/nginx/conf.d/00-aihr-request-protection.conf',before:null,after:hash(http),base64:Buffer.from(http).toString('base64')});
 return {kind:'STAGING_INGRESS_EMAIL_SECURITY',format:1,source:manifest.source,buildId,workerBefore,agentSha256:manifest.agent.sha256,nodeSha256:manifest.runtime.nodeSha256,publicOrigin,files};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [baselinePath,manifestPath,workerBefore,buildId,publicOrigin,output]=process.argv.slice(2);assert(output,'Usage: prepare-maintenance.mjs <private-baseline> <verified-artifact-manifest> <worker-before-sha256> <installed-build-id> <public-https-origin> <private-output>');
 const manifest=JSON.parse(readFileSync(manifestPath)),directory=dirname(resolve(manifestPath));
 for(const record of [manifest.agent,manifest.maintenance])assert(hash(readFileSync(join(directory,record.file)))===record.sha256,'Actual artifact bytes differ');
 assert.equal(hash(readFileSync(new URL('./ingress-policy.mjs',import.meta.url))),manifest.maintenance.ingressPolicySha256,'Actual reviewed policy differs from artifact source');
 const plan=createMaintenancePlan(JSON.parse(readFileSync(baselinePath)),manifest,{workerBefore,buildId,publicOrigin}),bytes=JSON.stringify(plan,null,2)+'\n';writeFileSync(output,bytes,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({kind:'PRIVATE_MAINTENANCE_PLAN_NOT_APPLIED',source:plan.source,buildId,sha256:hash(bytes),changedFiles:plan.files.length,writesToStaging:false}));
}
