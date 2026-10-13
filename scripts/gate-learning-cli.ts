import { readFileSync } from 'node:fs';
import { saveMirroredRelease,riskKnowledge,type ReleaseObservation } from './gate-learning';
if(process.argv[2]==='record-release'){
 const input=JSON.parse(readFileSync(0,'utf8')) as ReleaseObservation;
 const record=saveMirroredRelease(input);
 console.log(JSON.stringify({id:record.id,sha:record.sha,unknowns:record.unknowns.length,transitions:record.transitions.length}));
}else if(process.argv[2]==='status'){console.log(JSON.stringify(riskKnowledge(),null,2));}
else throw Error('usage: gate-learning-cli.ts record-release < release-evidence.json | status');
