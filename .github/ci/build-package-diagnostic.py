"""Read-only dependency comparison evidence before extracting any build bytes."""
import importlib.util
import json
from pathlib import Path
import sys
spec=importlib.util.spec_from_file_location("bundle",Path(__file__).with_name("build-bundle.py"))
bundle=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundle)
def inspect(source,origin):
    source=Path(source).absolute();rows=[]
    for name in ["fontkit","sharp"]:
        raw,target=bundle.package_identity(source,name);row={"package":name,"rawIdentity":raw}
        try:
            compared,_=bundle.package_identity(source,name,producer_source=origin)
            row["originComparedIdentity"]=compared
        except (ValueError,OSError) as error:row["comparisonError"]=str(error)
        shim=target/"node_modules/.bin/semver"
        if name=="sharp" and shim.exists():
            before=bundle.regular(shim,16384);data=shim.read_bytes()
            row["installerShim"]={"path":"node_modules/.bin/semver","bytes":len(data),"sha256":bundle.hashlib.sha256(data).hexdigest(),
                "text":data.decode("utf8")}
        row["rawFiles"]=[{"path":p.relative_to(target).as_posix(),"size":p.stat().st_size,"sha256":bundle.digest_file(p)} for p in sorted(target.rglob("*")) if p.is_file()]
        rows.append(row)
    return {"format":1,"kind":"read-only-package-relocation-comparison","runtimeSource":str(source),"producerSource":origin,"packages":rows,"releaseAuthorized":False}
if __name__=="__main__":
    if len(sys.argv)!=3:raise SystemExit("Usage: build-package-diagnostic.py RUNTIME_SOURCE AUTHENTICATED_PRODUCER_SOURCE")
    print(json.dumps(inspect(*sys.argv[1:]),sort_keys=True))
