"""Run only as nobody inside the actual worker mount namespace, never a model."""
import errno
import json
import os
import pathlib
import sys

assert sys.platform == 'linux' and os.geteuid() == 65534 and len(sys.argv) == 5
release, producer, checkout, nonce = sys.argv[1:]
assert release == '/var/lib/aihr-admission/release' and len(nonce) == 32
assert all(character in '0123456789abcdef' for character in nonce)
for original in (producer, checkout):
    assert original.startswith('/home/') and '..' not in original.split('/')
    try:
        os.open(original + '/package.json', os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.ENOENT, errno.ENOTDIR)
    else:
        raise AssertionError('Original checkout is visible in worker namespace')
    try:
        os.open(original + '/.native-write-' + nonce, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.ENOENT, errno.EROFS, errno.ENOTDIR)
    else:
        raise AssertionError('Original checkout is writable in worker namespace')
for parent in ('', '/.next', '/.next/server', '/.next/cache', '/node_modules'):
    try:
        os.open(release + parent + '/.native-write-' + nonce, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES)
    else:
        raise AssertionError('Immutable code parent is writable')
for target in ('.next/cache/images', '.next/cache/fetch-cache', '.next/server/route-cache'):
    file = pathlib.Path(release, target, '.native-write-' + nonce)
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, b'fictional native cache boundary\n')
    finally:
        os.close(fd)
        file.unlink()
print(json.dumps({'actualNamespaceFilesystemVerified': True, 'cacheWrites': 3,
                  'immutableParentRefusals': 5, 'originalCheckoutReadWriteRefusals': 4}))
