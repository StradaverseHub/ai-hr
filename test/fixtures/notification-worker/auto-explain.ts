/** Bounded PG16 parser adapted from the reviewed actual native lookup parser.
 * Parsing establishes no source, authority or successful execution claim. */
export type AutoExplainMessage={pid:number;durationMs:number;query:string;document:Record<string,unknown>;context:string};
/** Parse real PG16 auto_explain JSON objects, retaining native error context.
 * Synthetic parser tests establish parsing only; a source hash never replaces a plan. */
export function notificationAutoExplainMessages(log:string,pid:number):AutoExplainMessage[]{
 if(Buffer.byteLength(log)>64*1024*1024||!Number.isSafeInteger(pid)||pid<1)throw Error('Unbounded native plan log');
 const headers=[...log.matchAll(/^.*?\[([0-9]+)\]\s+(?:LOG|NOTICE|WARNING|ERROR|FATAL|PANIC):/gm)];
 if(headers.length>100000)throw Error('Excessive native log messages');
 const result:AutoExplainMessage[]=[];
 for(let index=0;index<headers.length;index++){
  const header=headers[index];if(Number(header[1])!==pid)continue;
  const text=log.slice(header.index!+header[0].length,headers[index+1]?.index??log.length);
  const timing=/^\s*duration:\s*([0-9]+(?:\.[0-9]+)?)\s+ms\s+plan:\s*/.exec(text);if(!timing)continue;
  const source=text.slice(timing[0].length);if(source[0]!=='{')throw Error('Native plan JSON object required');
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let position=0;position<source.length;position++){
   const char=source[position];
   if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
   if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){end=position+1;break;}
  }
  if(end<0)throw Error('Truncated native plan JSON');
  const document:unknown=JSON.parse(source.slice(0,end));
  if(!document||typeof document!=='object'||Array.isArray(document)||!('Query Text'in document)||typeof document['Query Text']!=='string'
   ||!('Plan'in document)||!document.Plan||typeof document.Plan!=='object'||Array.isArray(document.Plan))throw Error('Native executable plan fields required');
  const plan=document.Plan;
  if(!('Node Type'in plan)||typeof plan['Node Type']!=='string'||!plan['Node Type']
   ||!('Actual Rows'in plan)||typeof plan['Actual Rows']!=='number'||!Number.isFinite(plan['Actual Rows'])||plan['Actual Rows']<0
   ||!('Actual Loops'in plan)||typeof plan['Actual Loops']!=='number'||!Number.isFinite(plan['Actual Loops'])||plan['Actual Loops']<0)throw Error('Actual native execution rows/loops required');
  const durationMs=Number(timing[1]);if(!Number.isFinite(durationMs)||durationMs<0)throw Error('Finite native plan duration required');
  result.push({pid,durationMs,query:document['Query Text'],document:document as Record<string,unknown>,context:source.slice(end)});
 }
 return result;
}
