/** Explicit in-memory hash only; no database, filesystem, environment or connection owner. */
import {createHash} from 'node:crypto';
import {masterArtifactFingerprint,type MasterArtifactFingerprint} from './employee-master-artifact-model';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE,XLSX_EMAIL_ATTACHMENT_MAX_BYTES} from './email-attachment';
export function fingerprintReportBytes(bytes:Uint8Array,contentType:string):MasterArtifactFingerprint {
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>XLSX_EMAIL_ATTACHMENT_MAX_BYTES||contentType!==XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE)throw new Error('Invalid report artifact.');
  return masterArtifactFingerprint.parse({sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.byteLength,contentType});
}
