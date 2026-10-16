/** Public trust material only. Never accepts a private key or ignores an unparsed certificate. */
import {X509Certificate} from 'node:crypto';
export const INTERNAL_REPORT_CA_MAX_BYTES=256*1024;
export const INTERNAL_REPORT_CA_MAX_CERTIFICATES=256;
export function validateInternalReportCa(bytes:Uint8Array):Uint8Array{
 if(bytes.byteLength<1||bytes.byteLength>INTERNAL_REPORT_CA_MAX_BYTES)throw new Error('Invalid public SMTP trust material.');
 const text=Buffer.from(bytes).toString('utf8');
 if(/PRIVATE KEY|\0/.test(text))throw new Error('Private key is not public SMTP trust material.');
 const pattern=/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,certificates=[...text.matchAll(pattern)];
 if(certificates.length<1||certificates.length>INTERNAL_REPORT_CA_MAX_CERTIFICATES)throw new Error('Invalid public SMTP trust material.');
 const remainder=text.replace(pattern,'').split('\n').filter(line=>!line.trim().startsWith('#')).join('');
 if(remainder.trim())throw new Error('Unrecognized SMTP trust material.');
 for(const certificate of certificates)new X509Certificate(certificate[0]);
 return bytes;
}
