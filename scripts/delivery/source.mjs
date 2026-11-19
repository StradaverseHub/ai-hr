import {execFileSync} from 'node:child_process';
import {hash,sha} from './protocol.mjs';
export const policyPath=p=>p.startsWith('scripts/delivery/')||p.startsWith('.github/ci/')||p.startsWith('.github/workflows/delivery-')||/^scripts\/gate-(impact|tier|db|affected)/.test(p);
export function controllerDigestAt(cwd,ref){
 if(!sha(ref))throw Error('Exact controller required');
 const rows=execFileSync('git',['ls-tree','-r','-z',ref],{cwd,encoding:'utf8',maxBuffer:32*1024**2}).split('\0').filter(Boolean).map(row=>{const [meta,path]=row.split('\t');return [path,meta.split(' ')[2]];});return hash(rows.filter(([p])=>policyPath(p)).sort());
}
