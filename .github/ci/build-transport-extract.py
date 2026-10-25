"""Private, bounded binary diagnostic artifact extraction; never release authority."""
import importlib.util
import os
from pathlib import Path
import stat
import sys
import zipfile

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).with_name("build-bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)
LIMITS = {
    "build-provenance.json": 1024**2,
    "system-testing.json": 80*1024,
    "successful-build.json": 1024**2,
    "bytes/build-bundle-files.json": 16*1024**2,
    "bytes/build-bundle.tar.gz": 256*1024**2,
}
MAX_ZIP = 280*1024**2

def extract(archive, output, expected_digest):
    archive, output = Path(archive).absolute(), Path(output).absolute()
    bundle.require(isinstance(expected_digest, str) and bundle.re.fullmatch("[a-f0-9]{64}", expected_digest), "ZIP digest missing")
    before = bundle.regular(archive, MAX_ZIP)
    bundle.require(bundle.digest_file(archive) == expected_digest, "authenticated ZIP digest differs")
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        bundle.require(len(entries) in {5, 6}, "unexpected diagnostic ZIP member count")
        names = [i.filename for i in entries]
        bundle.require(len(set(names)) == len(names) and set(names) in [set(LIMITS), set(LIMITS)|{"bytes/"}], "diagnostic ZIP inventory differs")
        for i in entries:
            mode = i.external_attr >> 16
            bundle.require(not i.flag_bits & 1 and i.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}, "encrypted/unsupported ZIP")
            if i.filename == "bytes/":
                bundle.require(i.is_dir() and not i.file_size and stat.S_IFMT(mode) in {0, stat.S_IFDIR}, "invalid ZIP directory")
            else:
                bundle.require(not i.is_dir() and stat.S_IFMT(mode) in {0, stat.S_IFREG} and i.file_size <= LIMITS[i.filename], "nonregular/oversized ZIP file")
        owned = bundle.OwnedOutput(output)
        try:
            (output/"bytes").mkdir(mode=0o700)
            for i in entries:
                if i.filename == "bytes/": continue
                count = 0
                with z.open(i) as source, (output/i.filename).open("xb") as target:
                    for data in iter(lambda: source.read(1024**2), b""):
                        count += len(data)
                        bundle.require(count <= LIMITS[i.filename], "expanded ZIP exceeds bound")
                        target.write(data)
                bundle.require(count == i.file_size, "ZIP file size differs")
                os.chmod(output/i.filename, 0o600)
            bundle.require(bundle.identity(archive.stat()) == bundle.identity(before) and bundle.digest_file(archive) == expected_digest, "ZIP changed during extraction")
            owned.assert_owned()
        except BaseException as error:
            owned.cleanup_after_failure(error)
            raise
        finally:
            owned.close()

if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: build-transport-extract.py ZIP NEW_PRIVATE_OUTPUT AUTHENTICATED_SHA256")
    extract(*sys.argv[1:])
