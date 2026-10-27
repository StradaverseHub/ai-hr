import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bonusCompilerCheckoutPins,inspectBonusCompiler} from './bonus-compiler-evidence.mjs';
const control='dc74b804fcecb4bab3207e82c9b9f099b9bf13be',candidate='d52563c666d39074217ed42191866add4a2793a0';
const log=pins=>pins.flatMap(pin=>['typecheck\tRun actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\t2026-10-27T00:00:00Z [command]/usr/bin/git log -1 --format=%H',
 'typecheck\tRun actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\t2026-10-27T00:00:01Z '+pin]).join('\n');
test('requires both actual controller and candidate checkout pins in order',()=>assert.deepEqual(bonusCompilerCheckoutPins(log([control,candidate])),[control,candidate]));
for(const [name,text] of [['missing source',log([control])],['reversed',log([candidate,control])],['duplicate',log([control,candidate,candidate])],['foreign source',log([control,'0'.repeat(40)])],['application stdout cannot impersonate checkout step',log([control,candidate]).replaceAll('Run actions/checkout@','Run bash ../automation/.github/ci/typecheck.sh@')]])test('refuses '+name,()=>assert.throws(()=>bonusCompilerCheckoutPins(text)));
test('compiler refuses a non-authentic snapshot before log inspection',()=>assert.throws(()=>inspectBonusCompiler({run:{},jobs:[]})));
