/** Complete predecessor reconstruction only. Never executes historical source. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
type Change={startLine:number;endLine:number;before:string;after:string};
type Row={parentSha256:string;currentSha256:string;changes:Change[]};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function employeeChoiceRestorationSourceInverse(file:string,current:string){
 const proof=JSON.parse(readFileSync('docs/qualification/employee-native-restoration-inverse-20261108.json','utf8'))as{base:string;files:Record<string,Row>};
 if(proof.base!=='ee5722312689fc88d8a9253c232945e6f2599900'||!Object.hasOwn(proof.files,file))throw Error('Known complete restoration predecessor required');
 const row=proof.files[file];if(hash(current)!==row.currentSha256)throw Error('Complete restoration current source changed');
 const lines=current.match(/[^\n]*\n|[^\n]+$/g)??[];let frontier=lines.length;
 for(const change of row.changes){
  if(!Number.isSafeInteger(change.startLine)||!Number.isSafeInteger(change.endLine)||change.startLine<0||change.startLine>change.endLine||change.endLine>frontier||lines.slice(change.startLine,change.endLine).join('')!==change.after)throw Error('Exact complete restoration source range required');
  lines.splice(change.startLine,change.endLine-change.startLine,...(change.before.match(/[^\n]*\n|[^\n]+$/g)??[]));frontier=change.startLine;
 }
 const original=lines.join('');if(hash(original)!==row.parentSha256)throw Error('Complete restoration predecessor source differs');return original;
}
