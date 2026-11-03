import {parseArgs} from 'node:util';
import {z} from 'zod';

export class ProbationRuntimeRefused extends Error {}
const sha=z.string().regex(/^[a-f0-9]{40}$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const id=z.uuid();
const origin=z.string().refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.origin===value;}catch{return false;}});
const fields=z.object({
 operation:z.enum(['activate','pause','resume-legacy']),tenant:id,company:id,origin,source:sha,build:z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
 'database-identity':digest.optional(),reference:z.string().trim().min(3).max(500).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
 approval:id.optional(),digest:digest.optional(),apply:z.boolean().default(false),help:z.boolean().optional(),
}).strict();
export type ProbationRuntimeTarget=z.infer<typeof fields>;
export function parseProbationRuntimeTarget(args:readonly string[]):ProbationRuntimeTarget|null{
 let values:unknown;
 try{
  const parsed=parseArgs({args:[...args],strict:true,allowPositionals:false,tokens:true,options:{operation:{type:'string'},tenant:{type:'string'},company:{type:'string'},origin:{type:'string'},source:{type:'string'},build:{type:'string'},'database-identity':{type:'string'},reference:{type:'string'},approval:{type:'string'},digest:{type:'string'},apply:{type:'boolean'},help:{type:'boolean',short:'h'}}});
  const seen=new Set<string>();for(const token of parsed.tokens)if(token.kind==='option'){if(seen.has(token.name))throw new Error('duplicate');seen.add(token.name);}
  values=parsed.values;
 }catch{throw new ProbationRuntimeRefused('Use each supported target option once. Run --help for the full list.');}
 if(values&&typeof values==='object'&&'help' in values&&values.help===true)return null;
 const result=fields.safeParse(values);if(!result.success)throw new ProbationRuntimeRefused('Supply one company, its tenant, canonical HTTPS origin, full source SHA and installed build ID.');
 const value=result.data;
 if(value.operation==='pause'&&(value.approval||value.digest)||value.operation==='resume-legacy'&&value.digest)throw new ProbationRuntimeRefused('The review reference does not match the selected operation.');
 if(value.apply&&(!value['database-identity']||!value.reference||value.operation!=='pause'&&!value.approval||value.operation==='activate'&&!value.digest))throw new ProbationRuntimeRefused('Apply requires the independently reviewed installation reference, matching database identity and any exact named approval for this operation.');
 return value;
}
/** Reuse the deploy controller's source/build consistency report; this is not a health or acceptance receipt. */
export function assertProbationDeploymentTarget(report:string,actualOrigin:string,expected:Pick<ProbationRuntimeTarget,'origin'|'source'|'build'>):void{
 const values=new Map<string,string>();
 for(const line of report.trim().split('\n')){const index=line.indexOf('=');if(index<1)continue;const key=line.slice(0,index);if(values.has(key))throw new ProbationRuntimeRefused('Deployment state is ambiguous.');values.set(key,line.slice(index+1));}
 if(actualOrigin!==expected.origin||values.get('state')!=='ok'||values.get('exit_code')!=='0'||values.get('stale_build')!=='0'||values.get('ref')!==expected.source||values.get('built_ref')!==expected.source||values.get('build_id')!==expected.build||values.get('built_build_id')!==expected.build)throw new ProbationRuntimeRefused('The configured origin or current deployment source/build differs from the reviewed target.');
}
