"""Review-only JS replacement in an authenticated existing APK; no native rebuild."""
import pathlib,hashlib,json,os,re,sys,zipfile
root=pathlib.Path(os.environ['REVIEW_DIR']);base=pathlib.Path('base-artifact/OneHR-client-probe.apk')
assert hashlib.sha256(base.read_bytes()).hexdigest()=='605fa7384e3d9d297eec0bde0d66d3c79bb70277178259aa5ac9d78243d438cb'
bundle=pathlib.Path('source/mobile/android/app/build/generated/assets/react/release/index.android.bundle')
assert bundle.exists()
assert bundle.read_bytes()[:8]==bytes.fromhex('c61fbc03c103191f')
signature=lambda n: bool(re.fullmatch(r'META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))',n,re.I))
if '--verify' not in sys.argv:
 with zipfile.ZipFile(base) as old,zipfile.ZipFile(root/'unaligned.apk','w') as new:
  for info in old.infolist():
   if not signature(info.filename):new.writestr(info,bundle.read_bytes() if info.filename=='assets/index.android.bundle' else old.read(info.filename))
else:
 apk=root/'OneHR-client-probe.apk'
 with zipfile.ZipFile(base) as old,zipfile.ZipFile(apk) as new:
  before={n:hashlib.sha256(old.read(n)).hexdigest() for n in old.namelist() if not signature(n) and n!='assets/index.android.bundle'}
  after={n:hashlib.sha256(new.read(n)).hexdigest() for n in new.namelist() if not signature(n) and n!='assets/index.android.bundle'}
  assert before==after,'Unexpected native/resource/asset change'
  assert new.read('assets/index.android.bundle')==bundle.read_bytes()
 result={'source':os.environ['EXPECTED_SOURCE'],'jsSource':os.environ['EXPECTED_SOURCE'],'controller':os.environ['GITHUB_SHA'],'githubRun':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'platform':'android','abi':'arm64-v8a','configuration':'release','apk':'OneHR-client-probe.apk','apkSha256':hashlib.sha256(apk.read_bytes()).hexdigest(),'jsSha256':hashlib.sha256(bundle.read_bytes()).hexdigest(),'nativeBaseSource':'b918bac3abff806c157d270f286354b67a4c37bd','nativeBaseRun':41423483160,'nativeBaseApkSha256':hashlib.sha256(base.read_bytes()).hexdigest(),'allNonBundleNonSignatureEntriesByteIdentical':True,'unchangedEntries':len(before),'nativeCompiled':False,'reviewOnly':True,'productionOrStoreReady':False}
 (root/'manifest.json').write_text(json.dumps(result,indent=2)+'\n')
