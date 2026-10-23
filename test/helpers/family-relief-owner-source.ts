import {readFileSync} from 'node:fs';
/** Source-reading contracts must follow the real owner and must never pass on an empty slice. */
export function familyReliefFunctionSource(name:string):string {
 const source=readFileSync(new URL('../../db/migrations/0579_configurable_access.sql',import.meta.url),'utf8');
 const marker=`CREATE FUNCTION app.${name}(`;
 const start=source.indexOf(marker);
 const end=source.indexOf('$$;',start);
 if(start<0||end<=start||source.indexOf(marker,start+marker.length)>=0)throw Error(`Missing or ambiguous Family owner ${name}`);
 const body=source.slice(start,end+3);
 if(body.length<100)throw Error(`Empty Family owner ${name}`);
 return body;
}
