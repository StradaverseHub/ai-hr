/** Post-build: keep ONE copy of each byte-identical server source map.
 *
 * Turbopack emits the same server chunk under several names, one per chunk group that needs it,
 * and writes a full `.js.map` beside every copy. The copies of one chunk differ only in their final
 * `//# sourceMappingURL=<own name>.map` comment, so their maps are byte-identical. The shared core
 * service chunk alone (~12.7 MB map) is written 38 times, and the release archive stores every copy,
 * which is what pushed it over the release archive limit.
 *
 * For each set of byte-identical maps in the same directory, this keeps the first map by path and
 * points every other copy's chunk at it, by rewriting only that chunk's final sourceMappingURL
 * comment; the redundant map files are removed. Every chunk keeps its code byte-for-byte and still
 * names a map with exactly the same bytes in the same directory, so relative `sources` resolve to the
 * same files and every stack-trace or debugger mapping is unchanged. Nothing outside
 * `.next/server` is touched. A set is left exactly as it is unless every chunk in it ends by naming
 * its own map; a symbolic link or a map that changes while being read stops the build.
 *
 * Usage: node scripts/dedupe-server-source-maps.mjs [.next directory]   (default: ./.next)
 */
import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const COMMENT='//# sourceMappingURL=';

function* sourceMaps(directory){
 for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  const path=join(directory,entry.name);
  if(entry.isSymbolicLink())throw new Error('Unexpected symbolic link in the server build: '+path);
  if(entry.isDirectory())yield* sourceMaps(path);
  else if(entry.isFile()&&entry.name.endsWith('.js.map'))yield path;
 }
}

/** The chunk's final line names `mapName` (Turbopack writes it URL-encoded, e.g. `@` as `%40`).
 * Returns the code, where the URL starts and the URL text exactly as written, or null when the
 * chunk is missing or does not end by naming this map (such a map is left exactly as it is). */
function chunkComment(chunkPath,mapName){
 const stat=lstatSync(chunkPath,{throwIfNoEntry:false});
 if(!stat?.isFile()||stat.isSymbolicLink())return null;
 // Bytes, not text: the chunk's code is copied back exactly; only the ASCII URL is replaced.
 const code=readFileSync(chunkPath),at=code.lastIndexOf(COMMENT);
 if(at<0)return null;
 const url=code.subarray(at+COMMENT.length).toString('latin1').trimEnd();
 try{if(!/^[\x21-\x7e]+$/.test(url)||url.includes('/')||decodeURIComponent(url)!==mapName)return null;}catch{return null;}
 return {code,start:at+COMMENT.length,url};
}

/** Collapse byte-identical maps under <nextDirectory>/server; returns what changed. */
export function dedupeServerSourceMaps(nextDirectory){
 const server=join(resolve(nextDirectory),'server');
 if(!lstatSync(server).isDirectory())throw new Error('Next server build directory required: '+server);
 const groups=new Map();
 for(const path of sourceMaps(server)){
  const bytes=readFileSync(path);
  const key=dirname(path)+'\0'+bytes.length+'\0'+createHash('sha256').update(bytes).digest('hex');
  const group=groups.get(key);
  if(group)group.push(path);else groups.set(key,[path]);
 }
 const removed=[];let bytes=0,skipped=0;
 for(const [first,...copies] of groups.values()){
  if(!copies.length)continue;
  const members=[first,...copies].map(map=>({map,chunk:map.slice(0,-'.map'.length)}));
  for(const member of members)member.comment=chunkComment(member.chunk,basename(member.map));
  if(members.some(member=>!member.comment)){skipped+=members.length;continue;}
  const kept=readFileSync(first),keptUrl=members[0].comment.url;
  for(const {map,chunk,comment:{code,start,url}} of members.slice(1)){
   const duplicate=readFileSync(map);
   if(!duplicate.equals(kept))throw new Error('Source map changed while deduplicating: '+map);
   writeFileSync(chunk,Buffer.concat([code.subarray(0,start),Buffer.from(keptUrl,'latin1'),code.subarray(start+url.length)]));
   unlinkSync(map);
   removed.push(map);bytes+=duplicate.length;
  }
 }
 return {removed,bytes,skipped};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {removed,bytes,skipped}=dedupeServerSourceMaps(process.argv[2]??'.next');
 console.log(`Shared ${removed.length} duplicate server source maps (${bytes} bytes no longer stored twice); left ${skipped} identical maps whose chunks do not name them.`);
}
