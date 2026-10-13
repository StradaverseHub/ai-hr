import { readFileSync } from 'node:fs';
import { saveRelease,riskKnowledge,type ReleaseObservation } from './gate-learning';
if(process.argv[2]==='record-release'){
 const input=JSON.parse(readFileSync(0,'utf8')) as ReleaseObservation;
 if(input.gate&&input.gate.sha!==input.sha)throw Error('Release evidence belongs to another commit');
 if(!Array.isArray(input.classifications)||input.classifications.some(c=>!['low','moderate','high','unknown'].includes(c.risk)||typeof c.path!=='string'))throw Error('Invalid classification evidence');
 const record=saveRelease({sha:input.sha,buildId:input.buildId,gate:input.gate,classifications:input.classifications});
 console.log(JSON.stringify({id:record.id,sha:record.sha,unknowns:record.unknowns.length,transitions:record.transitions.length}));
}else if(process.argv[2]==='status'){console.log(JSON.stringify(riskKnowledge(),null,2));}
else throw Error('usage: gate-learning-cli.ts record-release < release-evidence.json | status');
