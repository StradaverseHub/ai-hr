/** Native wire grammar must be reviewed whenever its actual canonical parser changes. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect} from 'vitest';
export function assertAssessmentParserContract(){
 expect(JSON.parse(readFileSync('node_modules/zod/package.json','utf8')).version).toBe('4.6.7');
 for(const [file,hash] of [
  ['src/v4/core/regexes.ts','fd08a3d605812f51ac57e5c5b327682f99aaf741cff30a9363cb4f6afc60cdc9'],
  ['v4/core/checks.js','bc42543274218aa7ef72192b3218d2a4a399e53df8de240a04d9ff275096f563'],
  ['v4/core/util.js','bb08133b11b478c8e715038fff26ebea204d7fd5443fba31fe138b142d202efb'],
  ['v4/core/checks.cjs','9a2a428602fe9e380ea2a08495a47101a56710d814fe18fb0e6e30f65686a703'],
  ['v4/core/util.cjs','c7fd0ee0303e7344463692d0936d59c982ed28bb1b73dbd97d2b887ae15d80f1'],
 ])expect(createHash('sha256').update(readFileSync('node_modules/zod/'+file)).digest('hex'),file).toBe(hash);
}
