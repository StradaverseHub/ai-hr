import {createHash} from 'node:crypto';
import {client} from '../db/client';
/** Deliberately anonymous and purpose-bound: this database function returns no HR data or identities. */
export async function verifyPublicLetter(token:string):Promise<'valid'|'invalid'|'limited'>{
 const digest=createHash('sha256').update(/^[A-Za-z0-9_-]{43}$/.test(token)?token:'invalid').digest('hex');
 const [row]=await client.unsafe<{status:'valid'|'invalid'|'limited'}[]>('select app.verify_letter_status($1) as status',[digest]);
 if(!row||!['valid','invalid','limited'].includes(row.status))throw new Error('Letter verification unavailable');return row.status;
}
