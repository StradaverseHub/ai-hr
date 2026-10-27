"""Read-only package evidence. No app build/test/import, authority or host mutation."""
import base64,hashlib,json,os,pathlib,runpy,subprocess,sys
source=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]);m=runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1]/'build-bundle.py'))
assert str(source)=='/home/runner/work/ai-hr/ai-hr/source'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()=='9bf924ff3389fd5f5a41c03d062a40c429216585'
desc,target=m['package_identity'](source,'sharp');rows=[];shim=None
for base,dirs,files in os.walk(target,followlinks=False):
 for name in files:
  path=pathlib.Path(base)/name;rel=path.relative_to(target).as_posix();before=m['regular'](path,m['MAX_PACKAGE']);data=path.read_bytes()
  assert m['identity'](path.stat())==m['identity'](before)
  rows.append({'path':rel,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
  if rel=='node_modules/.bin/semver':shim={'rawBase64':base64.b64encode(data).decode(),'rawSha256':hashlib.sha256(data).hexdigest()}
rows.sort(key=lambda x:x['path']);assert hashlib.sha256(m['canonical'](rows)).hexdigest()==desc['packageTreeSha256']
result={'kind':'CLEAN_CI_SHARP_IDENTITY_DIAGNOSTIC_NOT_COVERAGE_OR_RELEASE','source':'9bf924ff3389fd5f5a41c03d062a40c429216585','controller':os.environ['AIHR_CI_CONTROL_HEAD'],'runId':int(os.environ['GITHUB_RUN_ID']),'descriptor':desc,'rows':rows,'shim':shim,'sourceRoot':str(source),'matchesFrozenBuildAlias':desc['packageTreeSha256']=='d69a084d753231b315413e9b8c3d7bf17abb7e4fe7b26bf9c68aa32e2a12ce2f','node':subprocess.check_output(['node','--version'],text=True).strip(),'pnpm':subprocess.check_output(['pnpm','--version'],text=True).strip(),'hostWritten':False,'applicationBuildOrTestsRun':False,'releaseAuthorized':False}
out.mkdir(mode=0o700,parents=True);(out/'sharp-package-identity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:result[k]for k in ['kind','source','descriptor','matchesFrozenBuildAlias','node','pnpm','releaseAuthorized']}))
