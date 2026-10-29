/** Server-only protocol hashing, deliberately outside the mobile contract export graph. */
import {createHash} from 'node:crypto';
import {onlineClockClientData} from '../mobile-clock-integrity';

export function onlineClockClientDataHash(input:unknown):Buffer{
  return createHash('sha256').update(onlineClockClientData(input),'utf8').digest();
}
