import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {describe,expect,it} from 'vitest';

/** Execute the actual probe's generated creator, with real child umasks and private files.
 * This checks fixture construction only; Linux UID/DAC/isolation remains actual VM acceptance.
 */
describe('installed isolation probe artifact fixture',()=>{
 it.each([0o077,0o022])('matches the renderer file mode under observer mask %i',observerMask=>{
  const source=String.raw`
import ast,json,os,pathlib,stat,subprocess,sys,tempfile
probe=pathlib.Path(sys.argv[1])
tree=ast.parse(probe.read_text())
creators=[]
for node in ast.walk(tree):
 if not isinstance(node,ast.Call) or not isinstance(node.func,ast.Name) or node.func.id!='as_user' or len(node.args)<2:continue
 if not isinstance(node.args[0],ast.Constant) or node.args[0].value!='aihr-report-renderer':continue
 expression=node.args[1]
 if isinstance(expression,ast.BinOp) and isinstance(expression.op,ast.Mod) and isinstance(expression.left,ast.Constant):
  template=expression.left.value
  if isinstance(template,str) and "os.write(f,b'fictional')" in template:creators.append(template)
assert len(creators)==1,'Identify the one real probe artifact creator'
with tempfile.TemporaryDirectory(prefix='aihr-probe-artifact-') as directory:
 target=pathlib.Path(directory)/'fictional.xlsx'
 previous=os.umask(int(sys.argv[2]))
 try:subprocess.run([sys.executable,'-I','-B','-c',creators[0]%str(target)],check=True)
 finally:os.umask(previous)
 facts={'mode':oct(stat.S_IMODE(target.stat().st_mode)),'content':target.read_text()}
 assert facts['mode']=='0o640',json.dumps(facts)
 print(json.dumps(facts))
`;
  const result=execFileSync('python3',['-I','-B','-c',source,path.join(process.cwd(),'deploy/identity-email/verify-internal-report-isolation.py'),String(observerMask)],{encoding:'utf8',timeout:10_000});
  expect(JSON.parse(result)).toEqual({mode:'0o640',content:'fictional'});
 });
});
