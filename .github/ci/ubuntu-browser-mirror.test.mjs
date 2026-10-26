import test from 'node:test';
import assert from 'node:assert/strict';
import {ubuntuMirrorSource} from './ubuntu-browser-mirror.mjs';
const stanza='Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
test('baseline is byte-identical and primary changes only the official transport endpoint',()=>{
 const input='# Runner archive\n'+stanza+'\n'+stanza.replace('noble noble-updates noble-backports','noble-security');
 const baseline=ubuntuMirrorSource(input,'runner'),primary=ubuntuMirrorSource(input,'primary-https');
 assert.equal(baseline.text,input);assert.equal(baseline.proof.beforeSha256,baseline.proof.afterSha256);
 assert.equal(primary.text,input.replaceAll('http://azure.archive.ubuntu.com','https://archive.ubuntu.com'));
 assert.equal(primary.proof.stanzas,2);assert.equal(primary.proof.releaseAuthorized,false);
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
