"""Hosted package/CLI import controls. Never contacts staging or executes the finalizer."""
import hashlib,json,shutil,subprocess,sys,tempfile
from pathlib import Path

root=Path(sys.argv[1]).resolve()
probe="import {pathToFileURL} from 'node:url'; const p=process.argv[1]; const m=await import(pathToFileURL(p+'/.github/ci/post-arrival-cleanup-server.mjs')); const t=m.verifyTool(p); console.log(JSON.stringify({controller:t.controller,toolSha256:t.toolSha256,sourceFiles:t.sourcePaths.length,executionAuthorized:false}));"
def verify(path):return subprocess.run(['node','--input-type=module','-e',probe,str(path)],capture_output=True,text=True,timeout=30)
result=verify(root);assert result.returncode==0,result.stderr
summary=json.loads(result.stdout);assert summary['executionAuthorized'] is False and summary['sourceFiles']>8000
manifest=json.loads((root/'post-arrival-tool.json').read_text())
assert summary['toolSha256']==hashlib.sha256((root/'post-arrival-tool.json').read_bytes()).hexdigest()
paths={r['path'] for r in json.loads((root/'source-files.json').read_text())['files']}
assert 'scripts/improve/system-testing-manifest.ts' in paths and '.github/ci/cleanup-install.py' in paths
assert not any(p.startswith('docs/adr/') or p.startswith('.env') or p.startswith('.claude/') or p.startswith('mobile/android/') for p in paths)
for case in ['tamper','extra','missing','traversal','link']:
    with tempfile.TemporaryDirectory(prefix='cleanup-package-control-') as parent:
        copy=Path(parent)/'tool';shutil.copytree(root,copy)
        if case=='tamper':(copy/'source-files.json').write_text('{}')
        elif case=='extra':(copy/'unreviewed.mjs').write_text('throw Error("never execute")')
        elif case=='missing':(copy/'.github/ci/post-arrival-cleanup-policy.mjs').unlink()
        elif case=='link':(copy/'unreviewed-link').symlink_to('/etc/passwd')
        else:
            changed=json.loads((copy/'post-arrival-tool.json').read_text());changed['files'][0]['path']='../outside'
            (copy/'post-arrival-tool.json').write_text(json.dumps(changed))
        refused=verify(copy);assert refused.returncode!=0,(case,refused.stdout)
print(json.dumps({'kind':'HOSTED_PACKAGE_REFUSAL_CONTROLS_NOT_EXECUTION_AUTHORITY','positive':True,'refused':5,'sourceFiles':len(paths),'executionAuthorized':False}))
