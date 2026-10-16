import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateInternalReportCa,INTERNAL_REPORT_CA_MAX_BYTES,INTERNAL_REPORT_CA_MAX_CERTIFICATES} from '../deploy/identity-email/internal-report-ca';
let directory:string,certificate:Buffer,key:Buffer;
beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'aihr-public-ca-'));execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-keyout',join(directory,'fictional.key'),'-out',join(directory,'fictional.pem'),'-subj','/CN=smtp.report-acceptance.invalid','-days','2'],{stdio:'ignore',timeout:10000});certificate=await readFile(join(directory,'fictional.pem'));key=await readFile(join(directory,'fictional.key'));});
afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
describe('canonical public CA propagation',()=>{
 it('accepts every real certificate in a bounded public bundle without changing bytes',()=>{const bundle=Buffer.concat([Buffer.from('# public fixture trust\n'),certificate,certificate]);expect(validateInternalReportCa(bundle)).toBe(bundle);});
 it('refuses a private key even alongside a valid certificate',()=>{expect(()=>validateInternalReportCa(key)).toThrow();expect(()=>validateInternalReportCa(Buffer.concat([certificate,key]))).toThrow();});
 it('parses all certificates and refuses a later malformed block or trailing hidden data',()=>{for(const extra of ['-----BEGIN CERTIFICATE-----\nnot-certificate\n-----END CERTIFICATE-----','arbitrary-secret','-----BEGIN OTHER-----\nYQ==\n-----END OTHER-----'])expect(()=>validateInternalReportCa(Buffer.concat([certificate,Buffer.from(extra)]))).toThrow();});
 it('refuses empty/oversize/too-many inputs without truncation',()=>{expect(()=>validateInternalReportCa(new Uint8Array())).toThrow();expect(()=>validateInternalReportCa(new Uint8Array(INTERNAL_REPORT_CA_MAX_BYTES+1))).toThrow();expect(()=>validateInternalReportCa(Buffer.from(certificate.toString().repeat(INTERNAL_REPORT_CA_MAX_CERTIFICATES+1)))).toThrow();});
});
