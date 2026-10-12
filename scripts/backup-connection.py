#!/usr/bin/env python3
"""Use libpq's parser and private connection state; never put a credential URL in argv.

Python 3 and the libpq shipped with PostgreSQL clients are required. URL values enter through the
named environment variable only. libpq owns URI/conninfo decoding, including SSL and percent escapes.
"""
import argparse
import ctypes
import ctypes.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


class Refused(Exception):
    pass


class Option(ctypes.Structure):
    _fields_ = [(name, ctypes.c_char_p) for name in
                ('keyword', 'envvar', 'compiled', 'val', 'label', 'dispchar')] + [('dispsize', ctypes.c_int)]


def parse_connection(value):
    candidates = []
    if os.environ.get('PG_BIN'):
        candidates += [str(Path(os.environ['PG_BIN']).parent / 'lib' / name)
                       for name in ('libpq.so.5', 'libpq.dylib')]
    candidates += [ctypes.util.find_library('pq'),
                   '/opt/homebrew/opt/postgresql@16/lib/libpq.dylib',
                   '/usr/local/opt/postgresql@16/lib/libpq.dylib']
    lib = None
    for candidate in filter(None, candidates):
        try:
            lib = ctypes.CDLL(candidate)
            break
        except OSError:
            pass
    if lib is None:
        raise Refused('libpq is unavailable; install PostgreSQL client libraries.')
    lib.PQconninfoParse.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    lib.PQconninfoParse.restype = ctypes.POINTER(Option)
    lib.PQconninfoFree.argtypes = [ctypes.POINTER(Option)]
    lib.PQfreemem.argtypes = [ctypes.c_void_p]
    error = ctypes.c_void_p()
    parsed = lib.PQconninfoParse(os.fsencode(value), ctypes.byref(error))
    if not parsed:
        if error:
            lib.PQfreemem(error)
        # libpq's diagnostic can quote the malformed input, including its password.
        raise Refused('invalid database connection configuration (details withheld to protect secrets).')
    result = {}
    try:
        index = 0
        while parsed[index].keyword:
            item = parsed[index]
            result[os.fsdecode(item.keyword)] = (
                os.fsdecode(item.envvar) if item.envvar else None,
                os.fsdecode(item.val) if item.val is not None else None)
            index += 1
    finally:
        lib.PQconninfoFree(parsed)
    return result


def private_directory(directory):
    target = Path(directory)
    absolute = target.absolute()
    if absolute in {Path('/'), Path('/tmp'), Path('/var/tmp'), Path.home(), Path.cwd()}:
        raise Refused('choose a dedicated backup staging subdirectory.')
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid():
            raise Refused('staging directory must belong to the backup account.')
        if stat.S_IMODE(info.st_mode) & 0o077 and os.listdir(fd):
            raise Refused('existing nonprivate staging directory is not empty; review its contents and permissions first.')
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url-env', default='AIHR_CONNECTION_URL')
    parser.add_argument('--field', choices=['dbname', 'user'])
    parser.add_argument('--database', help='Override the target database without rewriting a URI.')
    parser.add_argument('--private-dir')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.private_dir:
        private_directory(args.private_dir)
        return 0
    value = os.environ.get(args.url_env, '')
    if not value:
        raise Refused('database connection configuration is missing.')
    options = parse_connection(value)
    if args.field:
        result = options[args.field][1]
        if not result:
            raise Refused('database connection must explicitly name its database and user.')
        print(result)
        return 0
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise Refused('a PostgreSQL client command is required.')
    if args.database is not None:
        options['dbname'] = ('PGDATABASE', args.database)
    # Explicit options must not be silently displaced by an inherited service configuration.
    # Nested service indirection cannot be flattened without reading unrelated credential files.
    if options.get('service', (None, None))[1]:
        raise Refused('use an explicit database connection; nested service references are unsupported.')
    child_env = os.environ.copy()
    # Preserve libpq's environment defaults unless this connection explicitly overrides them.
    # Clearing an inherited PGSSLMODE=verify-full would silently weaken TLS to its default.
    child_env.pop('PGSERVICE', None)
    child_env.pop('PGSERVICEFILE', None)
    additional = []
    for key, (envvar, value) in options.items():
        if value is None:
            continue
        if envvar:
            child_env[envvar] = value
        else:
            # libpq offers no env var for keepalive knobs / private-key passphrases. Keep these in
            # a 0600 service file. Refuse values its line-based grammar cannot represent losslessly.
            if '\n' in value or '\r' in value or value != value.strip():
                raise Refused('a connection option cannot be represented safely in a service file.')
            additional.append(f'{key}={value}\n')
    with tempfile.TemporaryDirectory(prefix='aihr-pg-connection-') as directory:
        if additional:
            service = Path(directory) / 'pg_service.conf'
            service.write_text('[aihr_backup]\n' + ''.join(additional))
            child_env['PGSERVICEFILE'] = str(service)
            child_env['PGSERVICE'] = 'aihr_backup'
        # The client sees decoded PG* settings, including PGPASSWORD. No secret appears in argv.
        # A dedicated backup OS account is still necessary: root/the same UID can read environment.
        return subprocess.run(command, env=child_env, check=False).returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Refused, OSError, ValueError):
        # Never forward external exception text: it may contain an invalid URL or credential value.
        print('Backup connection refused: check connection syntax, private staging ownership, Python 3 and libpq availability; secret values are withheld.', file=sys.stderr)
        sys.exit(2)
