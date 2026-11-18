import {createHash} from 'node:crypto';
/** Server-only settings CAS token. Contains no personal values or database dependency. */
export function profileVisibilityFingerprint(raw:unknown){return createHash('sha256').update(JSON.stringify(raw??null)).digest('hex');}
