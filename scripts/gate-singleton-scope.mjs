/** Local receipts cannot impersonate authenticated host/cluster singleton units. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {singletonProfile} from '../.github/ci/singleton-protocol.mjs';
export const requiredHostedSingletons=files=>files.filter(file=>singletonProfile(file));
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const files=readFileSync(0,'utf8').trim().split('\n').filter(Boolean),required=requiredHostedSingletons(files);
 if(required.length){console.error('Full coverage requires authenticated hosted singleton units; this local controller cannot issue PASS:\n'+required.join('\n'));process.exitCode=2;}
}
