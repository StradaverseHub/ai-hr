"""JS-only simulator review package; native provenance stays explicit and immutable."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

BASES = {
 'ios': {'run':'42352332304','sha':'450b236753a198dfe92f2868ccf8dc2227403275','artifact':'onehr-ios-field-notes-450b236753a198dfe92f2868ccf8dc2227403275','file':'OneHR-simulator.zip','digest':'8e9dde04273918ea040ce5e379c7ba8310e6c52cbcfd9fbc4dbd24f9b2fd4ff0'},
 'android': {'run':'42352668846','sha':'7d6ff7f0991397c836296129a9601050c90946d5','artifact':'onehr-field-notes-android-7d6ff7f0991397c836296129a9601050c90946d5','file':'OneHR-Field-Notes-review.apk','digest':'c0c02ac71764b8a734b260b3d1c697a5c795160fde9385842f070fac85469b0e'},
}
def run(*args, **kwargs):
 return subprocess.run(args, check=True, **kwargs)
def output(*args):
 return subprocess.check_output(args, text=True).strip()
def sha(path):
 return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
 stage, platform = sys.argv[1:]
 base=BASES[platform]
 root=Path(os.environ['RUNNER_TEMP'])/('field-notes-refresh-'+platform)
 original=root/'base'
 bundle=root/'new.bundle'
 package=root/'package'
 head=output('git','rev-parse','HEAD')
 if stage=='prepare':
  # No lockfiles, configuration, assets, native module or widget implementation may drift.
  changed=output('git','diff','--name-only',base['sha'],head,'--','mobile').splitlines()
  permitted=lambda p: ((p.startswith('mobile/app/') or p.startswith('mobile/lib/')) and p.endswith(('.ts','.tsx'))) or p in ['mobile/DESIGN.md','mobile/.impeccable/design.json']
  refused=[p for p in changed if not permitted(p)]
  if refused:raise RuntimeError('Native inputs changed; a complete native build is required: '+', '.join(refused))
  original.mkdir(parents=True,exist_ok=True)
  run('gh','run','download',base['run'],'--name',base['artifact'],'--dir',str(original))
  if (original/'source.txt').read_text().strip()!=base['sha']:raise RuntimeError('Native source manifest mismatch')
  archive=original/base['file']
  if sha(archive)!=base['digest']:raise RuntimeError('Native artifact checksum mismatch')
  package.mkdir(parents=True,exist_ok=True)
  if platform=='ios':
   with zipfile.ZipFile(archive) as z:
    for name in z.namelist():
     if Path(name).is_absolute() or '..' in Path(name).parts:raise RuntimeError('Invalid native archive path')
   # ditto retains the framework symlinks and the original nested signatures.
   run('ditto','-x','-k',str(archive),str(root/'app'))
   native=(root/'app/OneHR.app/main.jsbundle').read_bytes()
  else:
   with zipfile.ZipFile(archive) as z:native=z.read('assets/index.android.bundle')
  (root/'native-header').write_bytes(native[:12])
  if native[:8].hex()!='c61fbc03c103191f':raise RuntimeError('Native artifact is not a Hermes bundle')
  with open(os.environ['GITHUB_OUTPUT'],'a') as out:out.write('review_root='+str(root)+'\n')
 elif stage=='package':
  if bundle.read_bytes()[:12]!=(root/'native-header').read_bytes():raise RuntimeError('Hermes engine/bytecode version mismatch')
  if platform=='ios':
   app=root/'app/OneHR.app'
   shutil.copyfile(bundle,app/'main.jsbundle')
   run('codesign','--force','--sign','-','--preserve-metadata=identifier,entitlements',str(app))
   run('codesign','--verify','--deep','--strict',str(app))
   artifact=package/'OneHR-simulator.zip'
   run('ditto','-c','-k','--keepParent',str(app),str(artifact))
  else:
   unsigned=root/'unsigned.apk'
   with zipfile.ZipFile(original/base['file']) as source,zipfile.ZipFile(unsigned,'w') as target:
    for entry in source.infolist():
     name=entry.filename
     if name=='assets/index.android.bundle' or re.fullmatch(r'META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))',name,re.I):continue
     target.writestr(entry,source.read(name))
    target.writestr('assets/index.android.bundle',bundle.read_bytes(),compress_type=zipfile.ZIP_DEFLATED)
   sdk=Path(os.environ.get('ANDROID_SDK_ROOT') or os.environ['ANDROID_HOME'])
   tools=sorted((sdk/'build-tools').iterdir(),key=lambda p:tuple(int(x) if x.isdigit() else 0 for x in p.name.split('.')))[-1]
   aligned=root/'aligned.apk';artifact=package/'OneHR-Field-Notes-review.apk'
   run(str(tools/'zipalign'),'-p','-f','4',str(unsigned),str(aligned))
   # This is Expo's public template review key, never a distribution credential.
   key='mobile/android/app/debug.keystore'
   run(str(tools/'apksigner'),'sign','--ks',key,'--ks-key-alias','androiddebugkey','--ks-pass','pass:android','--key-pass','pass:android','--out',str(artifact),str(aligned))
   def certificate(p):
    value=output(str(tools/'apksigner'),'verify','--print-certs',str(p))
    return re.findall(r'Signer #\d+ certificate SHA-256 digest: (\w+)',value)
   if not certificate(artifact) or certificate(artifact)!=certificate(original/base['file']):raise RuntimeError('Review update signer mismatch')
  (package/'source.txt').write_text(head+'\n')
  (package/'native-base.txt').write_text(base['sha']+'\n')
  (package/'review-manifest.json').write_text(json.dumps({'purpose':'local simulator review only','javascriptSource':head,'nativeSource':base['sha'],'nativeArtifactSha256':base['digest'],'bundleSha256':sha(bundle),'packageSha256':sha(artifact),'platform':platform},indent=2)+'\n')
  (package/'SHA256SUMS.txt').write_text(sha(artifact)+'  '+artifact.name+'\n')
 else:raise RuntimeError('Unknown stage')

if __name__=='__main__':main()
