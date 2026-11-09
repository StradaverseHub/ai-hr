"""Dormant argv for the fixed synthetic browser pre-import gate.

Only the protected owner of the live service and both pipe identities may
issue the grant. This module creates no service, pipe, mount or authorization.
"""


# The service receives these exact bytes as one Python -c argument. Keep both
# command grammars closed even if an eventual caller validates them separately.
_SOURCE = r'''
import fcntl
import os
import select
import stat
import sys
import time


def require(condition):
    if not condition:
        raise ValueError('synthetic-preimport-refused')


def node_command():
    args = sys.argv[1:]
    require(sys.argv[0] == '-c' and len(args) in (3, 4))
    role, run_id, raw_deadline = args[:3]
    require(role in ('driver', 'browser') and len(args) == (4 if role == 'browser' else 3))
    require(1 <= len(run_id) <= 16 and run_id.isascii() and run_id.isdecimal()
            and run_id[0] != '0' and int(run_id) <= 9007199254740991)
    require(1 <= len(raw_deadline) <= 19 and raw_deadline.isascii() and raw_deadline.isdecimal()
            and raw_deadline[0] != '0' and int(raw_deadline) <= 9223372036854775807)
    runtime = '/run/aihr-browser-capability-' + run_id + '/runtime'
    if role == 'browser':
        spki = args[3]
        require(len(spki) == 44 and spki[-1] == '=' and spki[42] in 'AEIMQUYcgkosw048'
                and all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/' for c in spki[:42]))
        script, option, uid = 'native-workload-browser-server.mjs', spki, 62121
    else:
        script, option, uid = 'native-workload-browser-driver.mjs', '--capability-only', 62120
    return (runtime + '/node', runtime + '/roles/' + script, option), uid, int(raw_deadline)


def run():
    argv, uid, deadline = node_command()
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64'
            and os.getresuid() == os.getresgid() == (uid, uid, uid)
            and os.getgroups() in ([], [uid]))
    stdin, stdout = os.fstat(0), os.fstat(1)
    require(stat.S_ISFIFO(stdin.st_mode) and stat.S_ISFIFO(stdout.st_mode)
            and (stdin.st_dev, stdin.st_ino) != (stdout.st_dev, stdout.st_ino)
            and fcntl.fcntl(0, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY
            and fcntl.fcntl(1, fcntl.F_GETFL) & os.O_ACCMODE == os.O_WRONLY)

    def remaining():
        ns = deadline - time.monotonic_ns()
        require(0 < ns <= 32000000000)
        return ns / 1000000000

    input_blocking, output_blocking = os.get_blocking(0), os.get_blocking(1)
    try:
        os.set_blocking(0, False)
        try:
            os.set_blocking(1, False)
            # Reject already readable stdin, including EOF, before publishing ready.
            require(select.select([0], [1], [], remaining()) == ([], [1], []))
            remaining()
            require(os.write(1, b'R\n') == 2)
            require(select.select([0], [], [], remaining()) == ([0], [], []))
            remaining()
            require(os.read(0, 3) == b'G\n')
        finally:
            os.set_blocking(1, output_blocking)
    finally:
        os.set_blocking(0, input_blocking)
    # The owner may have been descheduled before its write. No work goes
    # between the final child clock check and replacing this same process.
    remaining()
    os.execv(argv[0], argv)
    require(False)


if __name__ == '__main__':
    try:
        run()
    except BaseException:
        os._exit(125)
'''.lstrip()


def synthetic_preimport_argv(*, role, run_id, deadline_ns, spki=None):
    """Form only the fixed gate argv. The caller still owns native admission."""
    if (type(role) is not str or role not in ('driver', 'browser')
            or type(run_id) is not str or not 1 <= len(run_id) <= 16
            or not run_id.isascii() or not run_id.isdecimal() or run_id[0] == '0'
            or int(run_id) > 9007199254740991
            or type(deadline_ns) is not int or not 0 < deadline_ns <= 9223372036854775807):
        raise ValueError('synthetic-preimport-arguments')
    if role == 'browser':
        if (type(spki) is not str or len(spki) != 44 or spki[-1] != '=' or spki[42] not in 'AEIMQUYcgkosw048'
                or not all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/' for c in spki[:42])):
            raise ValueError('synthetic-preimport-spki')
    elif spki is not None:
        raise ValueError('synthetic-preimport-spki')
    argv = ('/usr/bin/python3', '-I', '-B', '-S', '-c', _SOURCE, role, run_id, str(deadline_ns))
    return (*argv, spki) if role == 'browser' else argv
