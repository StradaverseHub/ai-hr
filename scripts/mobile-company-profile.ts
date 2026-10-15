/** Offline operator tooling: private signing keys never enter the mobile project or a connection file. */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validCompanyProfile } from '../lib/mobile-connection';
const [command,keyPath,inputPath,outputPath] = process.argv.slice(2);
if(!['keygen','sign'].includes(command)||!keyPath||!inputPath||!outputPath)throw new Error('Usage: mobile-company-profile.ts keygen PRIVATE_PEM KEY_ID TRUST_JSON | sign PRIVATE_PEM PROFILE_JSON SIGNED_JSON');
if(resolve(keyPath).startsWith(resolve('.')+'/'))throw new Error('Keep the private key outside the source and build tree.');
if(existsSync(outputPath)||(command==='keygen'&&existsSync(keyPath)))throw new Error('Refusing to overwrite an existing output or private key.');
mkdirSync(dirname(outputPath),{recursive:true});
if(command==='keygen') {
 const pair=generateKeyPairSync('ed25519');
 writeFileSync(keyPath,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});
 const jwk=pair.publicKey.export({format:'jwk'});
 writeFileSync(outputPath,JSON.stringify([{keyId:inputPath,publicKey:jwk.x}],null,2)+'\n',{flag:'wx'});
 console.log('Created private operator key and public app trust anchor. Back up the private key securely; never distribute it.');
} else {
 if((statSync(keyPath).mode&0o077)!==0)throw new Error('Private signing keys must be accessible only to their owner.');
 const key=createPrivateKey(readFileSync(keyPath));if(key.asymmetricKeyType!=='ed25519')throw new Error('An Ed25519 signing key is required.');
 const profile=validCompanyProfile(JSON.parse(readFileSync(inputPath,'utf8')));
 const publicKey=createPublicKey(key).export({format:'jwk'}).x;
 const trust=JSON.parse(readFileSync('mobile/connections/trust.json','utf8')) as {keyId:string;publicKey:string}[];
 const approved=trust.find(k=>k.publicKey===publicKey);if(!approved)throw new Error('This key is not in the installed app trust anchors.');
 const bytes=Buffer.from(JSON.stringify(profile)),payload=bytes.toString('base64url');
 writeFileSync(outputPath,JSON.stringify({keyId:approved.keyId,payload,signature:sign(null,bytes,key).toString('base64url')},null,2)+'\n',{flag:'wx'});
 console.log('Signed public company setup file. It contains no credentials.');
}
