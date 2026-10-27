import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compilerCheckoutPins,inspectRuntimeCompiler} from './runtime-compiler-evidence.mjs';
const control='f050b1e4e881535f203839d5a34aed0a2a9f24ce',candidate='e07a86340d1ced979868bf4359d73597301d0f15';
const log=pins=>pins.flatMap(pin=>['typecheck\tRun actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\t2026-10-27T00:00:00Z [command]/usr/bin/git log -1 --format=%H',
 'typecheck\tRun actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\t2026-10-27T00:00:01Z '+pin]).join('\n');
test('requires both actual controller and candidate checkout pins in order',()=>assert.deepEqual(compilerCheckoutPins(log([control,candidate])),[control,candidate]));
for(const [name,text] of [['missing source',log([control])],['reversed',log([candidate,control])],['duplicate',log([control,candidate,candidate])],['foreign source',log([control,'0'.repeat(40)])],['application stdout cannot impersonate checkout step',log([control,candidate]).replaceAll('Run actions/checkout@','Run bash ../automation/.github/ci/typecheck.sh@')]])test('refuses '+name,()=>assert.throws(()=>compilerCheckoutPins(text)));
test('compiler refuses a non-authentic snapshot before log inspection',()=>assert.throws(()=>inspectRuntimeCompiler({run:{},jobs:[]})));
