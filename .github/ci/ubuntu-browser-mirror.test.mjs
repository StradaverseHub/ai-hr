import test from 'node:test';
import assert from 'node:assert/strict';
import {ubuntuMirrorSource} from './ubuntu-browser-mirror.mjs';
const stanza='Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
test('baseline is byte-identical and primary changes only the official transport endpoint',()=>{
 const input='# Runner archive\n'+stanza+'\n'+stanza.replace('noble noble-updates noble-backports','noble-security');
 const baseline=ubuntuMirrorSource(input,'runner'),primary=ubuntuMirrorSource(input,'primary-https');
 assert.equal(baseline.text,input);assert.equal(baseline.proof.beforeSha256,baseline.proof.afterSha256);
 assert.equal(primary.text,input.replaceAll('http://azure.archive.ubuntu.com','https://archive.ubuntu.com'));
 assert.equal(primary.proof.archiveStanzas,2);assert.equal(primary.proof.releaseAuthorized,false);
 assert.equal(primary.proof.signaturePolicyUnchanged,true);assert.equal(primary.proof.packageSelectionUnchanged,true);
});
for(const [label,input] of [
 ['different archive',stanza.replace('azure.archive.ubuntu.com','example.com')],
 ['missing keyring',stanza.replace(/^Signed-By:.*\n/m,'')],
 ['different keyring',stanza.replace('ubuntu-archive-keyring','another-keyring')],
 ['trusted override',stanza+'Trusted: yes\n'],
 ['signature bypass',stanza+'Allow-Insecure: yes\n'],
 ['freshness bypass',stanza+'Check-Valid-Until: no\n'],
 ['unknown suite',stanza.replace('noble-updates','resolute')],
 ['duplicate field',stanza+'URIs: http://azure.archive.ubuntu.com/ubuntu/\n'],
 ['multiline URI injection',stanza.replace('URIs: ','URIs: \n ')],
 ['source packages',stanza.replace('Types: deb','Types: deb deb-src')],
 ['unknown component',stanza.replace('universe','other')],
 ['null byte',stanza+'\0'],
 ['oversize',stanza+'#'.repeat(65536)],
])test('refuses '+label,()=>assert.throws(()=>ubuntuMirrorSource(input,'primary-https')));
test('refuses uncontrolled mirror variants',()=>assert.throws(()=>ubuntuMirrorSource(stanza,'https://example.com')));
const mirrors='http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n';
test('actual official runner mirror-list layout preserves signatures and separate security pocket',()=>{
 const archive=stanza.replace('http://azure.archive.ubuntu.com/ubuntu/','mirror+file:/etc/apt/apt-mirrors.txt');
 const security=stanza.replace('http://azure.archive.ubuntu.com/ubuntu/','http://security.ubuntu.com/ubuntu/').replace('noble noble-updates noble-backports','noble-security');
 const input=archive+'\n'+security;
 assert.equal(ubuntuMirrorSource(input,'runner',mirrors).text,input);
 const result=ubuntuMirrorSource(input,'primary-https',mirrors);
 assert.equal(result.text,input.replace('mirror+file:/etc/apt/apt-mirrors.txt','https://archive.ubuntu.com/ubuntu/'));
 assert.equal(result.proof.usesMirrorList,true);assert.equal(result.proof.archiveStanzas,1);
});
test('exact mirror-list source needs actual bounded recognized mirror order',()=>{
 const input=stanza.replace('http://azure.archive.ubuntu.com/ubuntu/','mirror+file:/etc/apt/apt-mirrors.txt');
 for(const bad of [undefined,'',mirrors.replace('priority:1','priority:5'),mirrors.replace('https://archive.ubuntu.com','https://example.com')])assert.throws(()=>ubuntuMirrorSource(input,'primary-https',bad));
 assert.throws(()=>ubuntuMirrorSource(input.replace('/etc/apt/apt-mirrors.txt','/tmp/mirrors'),'primary-https',mirrors));
});
test('observed AWS and other official regional EC2 runner entries map only to canonical signed HTTPS',()=>{
 const input=stanza.replace('http://azure.archive.ubuntu.com/ubuntu/','mirror+file:/etc/apt/apt-mirrors.txt');
 for(const region of ['us-east-2','eu-west-1','ap-southeast-2','us-gov-east-1']){
  const actual=mirrors.replace('azure.archive.ubuntu.com',region+'.ec2.archive.ubuntu.com');
  const r=ubuntuMirrorSource(input,'primary-https',actual);assert.equal(r.text,input.replace('mirror+file:/etc/apt/apt-mirrors.txt','https://archive.ubuntu.com/ubuntu/'));assert.equal(r.proof.signaturePolicyUnchanged,true);assert.equal(r.proof.packageSelectionUnchanged,true);
 }
});
for(const [label,endpoint]of [
 ['lookalike suffix','http://us-east-2.ec2.archive.ubuntu.com.evil.test/ubuntu/'],['lookalike prefix','http://evil-us-east-2.ec2.archive.ubuntu.com/ubuntu/'],['unrelated EC2 domain','http://us-east-2.ec2.amazonaws.com/ubuntu/'],['credentials','http://user@us-east-2.ec2.archive.ubuntu.com/ubuntu/'],['port','http://us-east-2.ec2.archive.ubuntu.com:80/ubuntu/'],['query','http://us-east-2.ec2.archive.ubuntu.com/ubuntu/?mirror=evil'],['fragment','http://us-east-2.ec2.archive.ubuntu.com/ubuntu/#evil'],['alternate path','http://us-east-2.ec2.archive.ubuntu.com/other/'],['unsigned downgrade of second mirror','http://example.test/ubuntu/'],
])test('regional mirror refuses '+label,()=>{const input=stanza.replace('http://azure.archive.ubuntu.com/ubuntu/','mirror+file:/etc/apt/apt-mirrors.txt');assert.throws(()=>ubuntuMirrorSource(input,'primary-https',mirrors.replace('http://azure.archive.ubuntu.com/ubuntu/',endpoint)));});
