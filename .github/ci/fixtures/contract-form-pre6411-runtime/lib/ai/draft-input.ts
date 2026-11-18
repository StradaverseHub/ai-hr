/** Ephemeral digest of actual captured outbound draft content. Never stores the prompt body. */
import {createHash} from 'node:crypto';
import type {GenerateArgs} from './types';
export function draftInputDigest(args:Pick<GenerateArgs,'system'|'prompt'|'maxTokens'>):string{
 return createHash('sha256').update(JSON.stringify({system:args.system,prompt:args.prompt,maxTokens:args.maxTokens??2048}),'utf8').digest('hex');
}
