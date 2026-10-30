/** Public diagnostics contain allowlisted categories and tracked relative locations, never raw errors. */
import {createHash} from 'node:crypto';
const categories=['Foreign source repository','Unsafe or duplicate artifact filename','Unexpected artifact directory','Artifact exceeds evidence bounds','One or more authenticated archive transfers failed','Unresolved application identity in later/active history','Unaccounted, pending, failed or superseding execution','Runtime changed','Outside finite source/plan','Original failure bytes/reason changed','Evidence metadata changed','Incomplete bounded API pagination','Resource not accessible by integration','Must have admin rights to Repository','API rate limit exceeded'];
export function publicRefusal(text,trackedScripts=[]){
 const allowed=new Set(trackedScripts),frames=[];
 const add=(script,line)=>{if(allowed.has(script)&&frames.length<16&&!frames.some(f=>f.script===script&&f.line===Number(line)))frames.push({script,line:Number(line)});};
 for(const match of text.matchAll(/\/(?:reader|source)\/((?:\.github\/ci|scripts\/improve|lib\/system-testing)\/[A-Za-z0-9._/-]+\.(?:mjs|py|ts)):(\d+)(?::\d+)?/g))add(match[1],match[2]);
 for(const match of text.matchAll(/File "[^"\n]*\/(?:reader|source)\/((?:\.github\/ci|scripts\/improve|lib\/system-testing)\/[A-Za-z0-9._/-]+\.(?:mjs|py|ts))", line (\d+)/g))add(match[1],match[2]);
 return {reason:categories.find(code=>text.includes(code))??'ASSESSMENT_REFUSED',diagnosticSha256:createHash('sha256').update(text).digest('hex'),httpStatuses:[...new Set([...text.matchAll(/\bHTTP ([345]\d{2})\b/g)].map(m=>Number(m[1])))],transportCodes:[...new Set(text.match(/\b(?:ENOBUFS|ETIMEDOUT|ENOENT|ECONNRESET|ERR_CHILD_PROCESS_STDIO_MAXBUFFER)\b/g)??[])],errorClasses:[...new Set(text.match(/\b(?:AggregateError|AssertionError|TypeError|ValueError|SyntaxError|ReferenceError)\b/g)??[])],frames};
}
