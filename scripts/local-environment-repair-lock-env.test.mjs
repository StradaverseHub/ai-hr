/** Actual pinned wrapper's env-pop loop and actual gate helper; no gate/test/DB execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LOCAL_REPAIR as P,digest} from './local-environment-repair.mjs';
const candidate=process.env.AIHR_REPAIR_FLOW_CANDIDATE;
assert.ok(candidate,'The exact frozen candidate path is required');
const archive=join(candidate,'scratchpad/board3-verification-20261023');
const extract=`import ast,json,sys
tree=ast.parse(open(sys.argv[1]).read())
loops=[n for n in tree.body if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='key']
assert len(loops)==1
n=loops[0]
assert isinstance(n.iter,ast.List) and all(isinstance(x,ast.Constant) and isinstance(x.value,str) for x in n.iter.elts)
assert len(n.body)==1 and not n.orelse and isinstance(n.body[0],ast.Expr)
c=n.body[0].value
assert isinstance(c,ast.Call) and isinstance(c.func,ast.Attribute) and isinstance(c.func.value,ast.Name) and c.func.value.id=='env' and c.func.attr=='pop' and not c.keywords
assert len(c.args)==2 and isinstance(c.args[0],ast.Name) and c.args[0].id=='key' and isinstance(c.args[1],ast.Constant) and c.args[1].value is None
env=json.loads(sys.stdin.read())
exec(compile(ast.Module(body=[n],type_ignores=[]),'<only-validated-env-pop-loop>','exec'),{'env':env,'__builtins__':{}})
print(json.dumps(env))
`;
test('Real inherited DB-lock environment sees one lease; actual corrected wrapper clears it and sees two test leases',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-repair-env-')));
 try{
  const state=join(root,'.aihr-gate-state');
  for(const sub of ['locks/slot.1','locks/slot.2','devdb-locks/slot.1']){const path=join(state,sub);mkdirSync(path,{recursive:true});writeFileSync(join(path,'pid'),String(process.pid)+'\n');}
  const fixture={HOME:root,PATH:process.env.PATH,AIHR_LOCK_DIR:join(state,'devdb-locks'),AIHR_TEST_SLOTS:'1',CHUNK_FROM:'2',CHUNK_TO:'8',GATE_NODB_PROOF:'1'};
  const run=(folder,expectedHash)=>{
   const path=join(archive,folder,'run.py');assert.equal(digest(readFileSync(path)),expectedHash);
   const env=JSON.parse(execFileSync('python3',['-c',extract,path],{input:JSON.stringify(fixture),encoding:'utf8'}));
   const held=execFileSync('bash',['-c','source "$1"; gate_slots_held_by_ancestors','lock-env-proof',join(candidate,'scripts/gate-lib.sh')],{env,encoding:'utf8'}).trim();
   return {env,held};
  };
  const old=run('local-verification-081-lock-environment-attempt',P.interruptedRunner);
  const corrected=run('local-verification-081',P.freshScripts['run.py']);
  assert.equal(old.held,'1');assert.equal(old.env.AIHR_TEST_SLOTS,'1');
  assert.equal(corrected.held,'2');
  for(const key of ['AIHR_LOCK_DIR','AIHR_TEST_SLOTS','CHUNK_FROM','CHUNK_TO','GATE_NODB_PROOF'])assert.equal(key in corrected.env,false,key);
 }finally{rmSync(root,{recursive:true});}
});
