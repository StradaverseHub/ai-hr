/** Source figure grounding: ignore extractor headings, dates, times and digits embedded in labels. */
export function evidenceNumbers(text:string){
 const out:{value:number;decimal:boolean;significant:number}[]=[];
 const own=text.replace(/^\s*(?:### Sheet:.*|--- page ---)\s*$/gm,' ').replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g,' ').replace(/\b(RM|USD|SGD|MYR|RMB)(?=\d)/gi,'$1 ');
 for(const match of own.matchAll(/(?<![A-Za-z0-9.])(\()?(-)?(\d[\d,]*(?:\.\d+)?)(\))?(?![0-9])/g)){
  const raw=match[3].replaceAll(',',''),number=Number(raw)*(match[2]||match[1]&&match[4]?-1:1);if(!Number.isFinite(number))continue;
  const significant=raw.replace('.','').replace(/^0+|0+$/g,'').length||1;
  out.push({value:number,decimal:raw.includes('.'),significant});
 }
 return out;
}
export function evidenceFigureInText(value:number,text:string){
 if(!Number.isFinite(value))return false;
 for(const number of evidenceNumbers(text)){
  if(value===0){if(number.value===0)return true;continue;}
  if(Math.abs(number.value-value)<=Math.abs(value)*0.005)return true;
  if(number.decimal||number.significant>=2)for(const scale of [1e3,1e6,1e9,1e-3,1e-6,1e-9,100,0.01]){const target=value*scale;if(Math.abs(number.value-target)<=Math.abs(target)*0.005)return true;}
 }
 return false;
}
