/** Order only: every specification and object identity remains present. No coverage selection. */
import {relative,resolve} from 'node:path';
import {testDurationHintMs} from '../.github/ci/db-scheduling.mjs';
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function orderTestSpecifications(files,{root,getFileTestResults=()=>undefined}){
 const metadata=new Map(files.map(spec=>{
  const file=relative(root,resolve(root,spec.moduleId)).split('\\').join('/'),project=spec.project.name;
  const cached=getFileTestResults(project+':'+file);
  return [spec,{group:spec.project.config.sequence?.groupOrder??0,project,isolate:Boolean(spec.project.config.isolate),failed:Boolean(cached?.failed),duration:Math.max(testDurationHintMs(file),Number.isFinite(cached?.duration)&&cached.duration>=0?cached.duration:0),file}];
 }));
 return files.slice().sort((a,b)=>{
  const x=metadata.get(a),y=metadata.get(b);
  return x.group-y.group||compare(x.project,y.project)||Number(y.isolate)-Number(x.isolate)||Number(y.failed)-Number(x.failed)||y.duration-x.duration||compare(x.file,y.file);
 });
}
