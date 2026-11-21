/** Node workers load the service graph without Next's bundler. `server-only` is a build-time marker with no runtime
 *  content, so it resolves to an empty module here (same intent as `--conditions=react-server`, which would also switch
 *  react itself to its server build and break modules like lucide-react that the import graph reaches). */
import Module from 'node:module';
import {join} from 'node:path';
const internal=Module as unknown as {_resolveFilename:(request:string,...rest:unknown[])=>string};
const original=internal._resolveFilename;
const empty=join(process.cwd(),'scripts/lib/empty-server-only.cjs');
internal._resolveFilename=function(this:unknown,request:string,...rest:unknown[]){
 return request==='server-only'?empty:original.call(this,request,...rest);
};
