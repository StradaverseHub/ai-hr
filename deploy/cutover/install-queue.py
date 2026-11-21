"""Install the ingress observer and queue integration on the commissioned staging host."""
import argparse
import base64
import json
from pathlib import Path
import shlex
import subprocess

REMOTE = r"""
import base64, fcntl, hashlib, json, os, pathlib, sqlite3, subprocess, sys, tempfile
root = pathlib.Path('/var/tmp/aihr-deploy/staging-release-queue')
os.umask(0o077)
payload = json.load(sys.stdin)
def owned(path, mode):
    stat = path.lstat()
    if path.resolve() != path or stat.st_uid != os.getuid() or stat.st_mode & 0o777 != mode:
        raise RuntimeError('Unexpected staging installation ownership')
def install(path, data):
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as stream:
        tmp = pathlib.Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
owned(root, 0o700)
for name in ('operations.lock', 'queue.sqlite3', 'coordinator.py'):
    owned(root/name, 0o600)
with (root/'operations.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    db = sqlite3.connect(root/'queue.sqlite3', timeout=5, isolation_level=None)
    db.execute('BEGIN IMMEDIATE')
    try:
        if db.execute('SELECT batch FROM lease').fetchone()[0] or db.execute("SELECT 1 FROM batches WHERE state='prepared'").fetchone():
            raise RuntimeError('A staging release is active or prepared')
        config = root/'cutover.json'
        existing = (root/'coordinator.py').read_bytes()
        coordinator = base64.b64decode(payload['files']['coordinator.py'], validate=True)
        old = hashlib.sha256(existing).hexdigest()
        if existing != coordinator and old != payload['previous']:
            raise RuntimeError('Unreviewed staging coordinator version found')
        if config.exists() or config.is_symlink():
            raise RuntimeError('Cutover is already commissioned')
        expected = {'root':'/var/lib/aihr-cutover', 'port':3301}
        marker = root/'cutover-candidate.json'
        for name in ('controller.py', 'next_probe.py', 'staging.py', 'canonical-deploy.sh'):
            install(root/name, base64.b64decode(payload['files'][name], validate=True))
        install(root/'coordinator-before-cutover.py', existing)
        install(root/'coordinator.py', coordinator)
        try:
            install(marker, json.dumps(expected).encode())
            probe = subprocess.run(
                [sys.executable, '-B', '-c',
                 'import json, pathlib, staging; print(json.dumps(staging.open_staging(pathlib.Path("cutover-candidate.json")).queue_state()))'],
                cwd=root, check=True, capture_output=True, text=True, timeout=30)
            live = json.loads(probe.stdout)
            if (live['ref'], live['build_id']) != (payload['baseline'], payload['build']):
                raise RuntimeError('Commissioned staging did not prove its expected live build')
            os.replace(marker, config)
        except BaseException:
            install(root/'coordinator.py', existing)
            raise
        finally:
            marker.unlink(missing_ok=True)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
        print(json.dumps({'commissioned':True,'source':live['ref'],'build':live['build_id']}))
    finally:
        db.execute('ROLLBACK')
        db.close()
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-config", type=Path, required=True)
    parser.add_argument("--previous", required=True, help="Reviewed installed coordinator SHA-256")
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--build", required=True)
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    files = {name: (here / name) for name in ("controller.py", "next_probe.py", "staging.py", "canonical-deploy.sh")}
    files["coordinator.py"] = here.parents[1] / "scripts/staging/coordinator.py"
    payload = {"previous": args.previous, "baseline": args.baseline, "build": args.build,
               "files": {name: base64.b64encode(path.read_bytes()).decode()
                         for name, path in files.items()}}
    subprocess.run([
        "ssh", "-F", str(args.ssh_config.resolve(strict=True)), "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=12", "aihr-staging",
        "python3 -B -c " + shlex.quote(REMOTE),
    ], input=json.dumps(payload).encode(), check=True, timeout=60)


if __name__ == "__main__":
    main()
