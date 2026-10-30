"""Owned staging-install cleanup. Retains audit evidence; never follows links or touches active build."""
from __future__ import annotations
import hashlib,json,os,platform,re,shutil,stat,sys,time
from pathlib import Path
def require(value,message):
    if not value:raise ValueError("Installation cleanup refused: "+message)
def canonical(value):return (json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()
def identity(st):return {"device":st.st_dev,"inode":st.st_ino}
def private(path):
    st=path.lstat()
    require(path.is_absolute() and path.resolve()==path and stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700,"owned canonical0700 installation directory required")
    return st
def read_record(fd,name,bound=64*1024):
    handle=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
    try:
        before=os.fstat(handle)
        require(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_nlink==1 and 0<before.st_size<=bound,"bounded owned immutable record required")
        data=b""
        while len(data)<=bound:
            chunk=os.read(handle,min(16384,bound+1-len(data)))
            if not chunk:break
            data+=chunk
        require(len(data)==before.st_size and identity(os.fstat(handle))==identity(before),"record changed during read")
        return data
    finally:os.close(handle)
def publish(fd,name,value):
    handle=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=fd)
    try:
        data=canonical(value);offset=0
        while offset<len(data):offset+=os.write(handle,data[offset:])
        os.fsync(handle)
    finally:os.close(handle)
    os.fsync(fd)
def build_id(fd):
    handle=os.open("BUILD_ID",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
    try:
        st=os.fstat(handle);require(stat.S_ISREG(st.st_mode) and 0<st.st_size<=513,"bounded active/retained build ID required")
        value=os.read(handle,514).decode().strip();require(re.fullmatch(r"[A-Za-z0-9_-]{1,512}",value),"valid build ID required");return value
    finally:os.close(handle)
def cleanup_install(directory,source):
    directory=Path(directory).absolute();source=Path(source).absolute()
    require(platform.system()=="Linux" and shutil.rmtree.avoids_symlink_attacks,"Linux descriptor-relative safe cleanup required")
    initial=private(directory);private(directory.parent)
    require(directory.parent.name==".aihr-ci-builds" and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}",directory.name),"exact private installation location required")
    require(source.resolve()==source and source.is_dir() and source!=directory and not source.is_relative_to(directory),"canonical separate runtime source required")
    handles=[]
    try:
        parent=os.open(directory.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);handles.append(parent)
        fd=os.open(directory.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent);handles.append(fd)
        source_fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);handles.append(source_fd)
        active_fd=os.open(".next",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=source_fd);handles.append(active_fd)
        require(identity(os.fstat(fd))==identity(initial),"installation replaced before cleanup")
        authorization=read_record(fd,"authorization.json",32768);grant=json.loads(authorization)
        authority_bytes=read_record(fd,"cleanup-authorized.json");authority=json.loads(authority_bytes)
        grant_hash=hashlib.sha256(authorization).hexdigest();authority_hash=hashlib.sha256(authority_bytes).hexdigest()
        require(authority.get("format")==1 and authority.get("kind")=="OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL"
                and authority.get("authorizationSha256")==grant_hash and authority.get("installId")==directory.name
                and authority.get("sourceDirectory")==str(source) and authority.get("directory")==identity(initial)
                and authority.get("source")==grant.get("source") and authority.get("buildRecordId")==grant.get("build",{}).get("buildRecordId")
                and authority.get("nextBuildId")==grant.get("build",{}).get("nextBuildId"),"exact immutable arrival cleanup authority required")
        def active():
            require(identity(os.stat(".next",dir_fd=source_fd,follow_symlinks=False))==authority["activeDirectory"]
                    and identity(os.fstat(active_fd))==authority["activeDirectory"] and build_id(active_fd)==authority["nextBuildId"],"active runtime/build identity changed")
            require(identity(os.stat(directory.name,dir_fd=parent,follow_symlinks=False))==identity(initial),"installation path replaced")
        active()
        intent={"format":1,"kind":"OWNED_INSTALL_CLEANUP_INTENT","authoritySha256":authority_hash,"directory":identity(initial),"children":["next","packet"]}
        try:
            existing=json.loads(read_record(fd,"cleanup-intent.json"));require(existing==intent,"cleanup intent differs")
        except FileNotFoundError:publish(fd,"cleanup-intent.json",intent)
        expected={"next":authority["retainedDirectory"],"packet":authority["packetDirectory"]}
        # Validate BOTH selected children before removing either. An absent child is safe on a retry:
        # this immutable intent is retained, and absence is reported, never attributed to a new delete.
        for name in ["next","packet"]:
            try:st=os.stat(name,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:continue
            require(stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and identity(st)==expected[name],"selected child type/owner/identity changed")
            if name=="next":
                retained=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                try:require(build_id(retained)==grant["baselineBuildId"],"retained old build identity differs")
                finally:os.close(retained)
        for name in ["next","packet"]:
            active()
            try:st=os.stat(name,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:continue
            require(stat.S_ISDIR(st.st_mode) and identity(st)==expected[name],"selected cleanup child replaced")
            shutil.rmtree(name,dir_fd=fd);os.fsync(fd)
        active()
        for name in ["next","packet"]:
            try:os.stat(name,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:continue
            raise ValueError("Installation cleanup refused: owned selected child remains")
        result={"format":1,"kind":"OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED","installId":directory.name,
                "authorizationSha256":grant_hash,"authoritySha256":authority_hash,"source":authority["source"],"nextBuildId":authority["nextBuildId"],
                "activeDirectory":authority["activeDirectory"],"verifiedAbsent":["next","packet"],"auditEvidenceRetained":True,"releaseHandbackVerified":False}
        try:require(json.loads(read_record(fd,"cleanup-result.json"))==result,"existing cleanup result differs")
        except FileNotFoundError:publish(fd,"cleanup-result.json",result)
        return result
    finally:
        for handle in reversed(handles):os.close(handle)
if __name__=="__main__":
    # Only the CLI on commissioned staging is guarded; isolated fixture functions stay pure.
    import pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts/staging'))
    from lease import guard_server_cli
    guard_server_cli()
    try:
        require(len(sys.argv)==2,"usage: cleanup-install.py PRIVATE_INSTALL_DIRECTORY")
        print(json.dumps(cleanup_install(sys.argv[1],"/opt/ai-hr"),sort_keys=True))
    except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError) as error:
        print(str(error),file=sys.stderr);sys.exit(1)
