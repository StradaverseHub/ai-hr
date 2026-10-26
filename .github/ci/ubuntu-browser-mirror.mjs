/** Diagnostic transport comparison; Ubuntu signatures and package selection stay authoritative. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function ubuntuMirrorSource(text,variant){
 assert(['runner','primary-https'].includes(variant),'Unknown diagnostic mirror variant');
 assert(typeof text==='string'&&text.length>0&&Buffer.byteLength(text)<=65536&&!text.includes('\0'),'Bounded Ubuntu sources required');
 const stanzas=text.split(/\n\s*\n/).filter(s=>s.split('\n').some(line=>line.trim()&&!line.trimStart().startsWith('#')));
 assert(stanzas.length>0&&stanzas.length<=8,'Bounded deb822 Ubuntu stanzas required');
 let replaced=0;
 for(const stanza of stanzas){
  const fields=new Map();
  for(const line of stanza.split('\n')){
   if(!line.trim()||line.trimStart().startsWith('#'))continue;
   const match=/^([A-Za-z][A-Za-z-]*):[ \t]*(\S(?:.*\S)?)\r?$/.exec(line);
   assert(match&&!fields.has(match[1].toLowerCase()),'Unsupported or duplicate Ubuntu source field');
   fields.set(match[1].toLowerCase(),match[2]);
  }
  assert(fields.get('types')==='deb','Binary Ubuntu archive required');
  assert(fields.get('signed-by')==='/usr/share/keyrings/ubuntu-archive-keyring.gpg','Ubuntu archive keyring must stay explicit');
  assert(![...fields.keys()].some(k=>/trusted|insecure|weak|check-valid-until/.test(k)),'Archive verification override refused');
  assert(fields.get('suites')?.split(/\s+/).every(s=>['noble','noble-updates','noble-backports','noble-security'].includes(s)),'Only Ubuntu24.04 suites supported');
  assert(fields.get('components')?.split(/\s+/).every(s=>['main','restricted','universe','multiverse'].includes(s)),'Unexpected Ubuntu components');
  assert(/^https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?$/.test(fields.get('uris')??''),'Expected the standard runner Azure Ubuntu archive');
  replaced++;
 }
 const after=variant==='runner'?text:text.replace(/^(URIs:[ \t]*)https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu(\/?)[ \t]*$/gm,'$1https://archive.ubuntu.com/ubuntu$2');
 assert(variant==='runner'||after!==text,'No archive transport was changed');
 // Removing precisely the URI values must yield byte-identical source configuration.
 const redactUris=value=>value.replace(/^(URIs:[ \t]*).*$/gm,'$1<ARCHIVE_URI>');
 assert.equal(redactUris(after),redactUris(text),'A non-URI archive setting changed');
 return {text:after,proof:{kind:'DIAGNOSTIC_UBUNTU_TRANSPORT_ONLY',variant,stanzas:replaced,beforeSha256:digest(text),afterSha256:digest(after),signaturePolicyUnchanged:true,packageSelectionUnchanged:true,releaseAuthorized:false}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.GITHUB_REPOSITORY_ID==='1333414856'&&process.env.GITHUB_WORKFLOW==='browser-provisioning-diagnostics','Disposable standard-runner diagnostic only');
 assert.equal(process.argv.length,4,'Expected fixed variant and private report path');
 const [variant,report]=process.argv.slice(2),file='/etc/apt/sources.list.d/ubuntu.sources';
 assert(report.startsWith(process.env.RUNNER_TEMP+'/')&&!report.includes('\0'),'Private runner output required');
 const stat=lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink(),'Regular Ubuntu sources required');
 const before=readFileSync(file,'utf8'),{text,proof}=ubuntuMirrorSource(before,variant);
 writeFileSync(report+'.original.sources',before,{flag:'wx',mode:0o600});
 if(text!==before)execFileSync('sudo',['-n','tee',file],{input:text,stdio:['pipe','ignore','inherit']});
 assert.equal(readFileSync(file,'utf8'),text,'Applied archive transport differs');
 writeFileSync(report,JSON.stringify({...proof,controller:process.env.GITHUB_WORKFLOW_SHA,candidate:process.env.AIHR_CI_HEAD,imageOS:process.env.ImageOS,imageVersion:process.env.ImageVersion},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify(proof));
}
