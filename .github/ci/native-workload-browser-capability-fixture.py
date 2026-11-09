"""Fixed synthetic TLS and inert TCP listeners for the protected browser owner.

Importing this module acquires nothing. The physical owner retains role,
firewall, namespace, and launch authority and disposes this fixture before
releasing its firewall. This module has no executable entry point.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import math
import os
import re
import secrets
import select
import signal
import socket
import ssl
import stat
import subprocess
import threading
import time
from contextlib import ExitStack

LOOPBACK = '127.0.0.1'
INGRESS, TRIPWIRE = 3443, 5433
INGRESS_URL = 'https://127.0.0.1:3443/__aihr_browser_capability_v1'
INGRESS_BODY = b'aihr-browser-capability-v1\n'
_REQUEST = b'GET /__aihr_browser_capability_v1 HTTP/1.1\r\nHost: 127.0.0.1:3443\r\n'
_PROBE_HEADER = b'x-aihr-fixture-probe'
_RESPONSE = (
    b'HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n'
    + b'Content-Length: ' + str(len(INGRESS_BODY)).encode('ascii') + b'\r\n'
    + b'Connection: close\r\nCache-Control: no-store\r\n'
    + b'Content-Security-Policy: default-src \'none\'\r\nX-Content-Type-Options: nosniff\r\n\r\n'
    + INGRESS_BODY
)
_HEADER_BYTES = 8192
_TLS_FILE_BYTES = 16384
_POLL = 0.05
_CONNECTION_SECONDS = 3
_NEGATIVES_FRONTIER = 42
_CRYPTO_SECONDS = 5
_CRYPTO_SETTLEMENT_SECONDS = 1


class FixtureRefusal(RuntimeError):
    pass


class _Stopped(Exception):
    pass


def _require(condition, reason):
    if not condition:
        raise FixtureRefusal(reason)


def _remaining(deadline):
    left = deadline - time.monotonic()
    _require(left > 0, 'fixture-deadline')
    return left


def _request_kind(data, nonce):
    _require(len(data) <= _HEADER_BYTES and data.endswith(b'\r\n\r\n'), 'fixture-http-framing')
    request, *headers = data[:-4].split(b'\r\n')
    _require(request == _REQUEST.split(b'\r\n', 1)[0] and len(headers) <= 48, 'fixture-http-request')
    seen = {}
    for line in headers:
        key, delimiter, value = line.partition(b':')
        _require(delimiter and re.fullmatch(rb'[A-Za-z0-9-]+', key)
                 and re.fullmatch(rb'[ -~]*', value), 'fixture-http-header')
        key = key.lower()
        _require(key not in seen, 'fixture-http-header')
        seen[key] = value.strip()
    _require(seen.get(b'host') == b'127.0.0.1:3443'
             and not seen.keys() & {b'content-length', b'transfer-encoding', b'upgrade',
                                    b'authorization', b'proxy-authorization', b'cookie'},
             'fixture-http-header')
    if _PROBE_HEADER not in seen:
        return 'browser'
    _require(hmac.compare_digest(seen[_PROBE_HEADER], nonce), 'fixture-probe-identity')
    return 'probe'


def _tls_context(owner, deadline):
    # All child file writes target anonymous held fds. No path accepts a
    # caller-supplied argument, and no OpenSSL stdout/stderr leaves this owner.
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
           'HOME': '/nonexistent', 'OPENSSL_CONF': '/dev/null'}
    seals = fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE
    with ExitStack() as files:
        def held():
            fd = os.memfd_create('aihr-browser-capability-tls', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
            files.callback(os.close, fd)
            os.fchmod(fd, 0o600)
            return fd, f'/proc/self/fd/{fd}'

        def openssl(arguments, inputs, output=None):
            try:
                owner._run_crypto(arguments, inputs, output, env, deadline)
            finally:
                if owner._crypto_unsettled():
                    # The child may still hold an inherited writer. Retain our
                    # descriptors and refuse physical fixture release.
                    owner._crypto_files = files.pop_all()

        def seal(fd):
            before = os.fstat(fd)
            _require(stat.S_ISREG(before.st_mode) and before.st_nlink == 0 and before.st_uid == 0
                     and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= _TLS_FILE_BYTES,
                     'fixture-tls-material')
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
            _require(fcntl.fcntl(fd, fcntl.F_GET_SEALS) == seals, 'fixture-tls-material')
            return before.st_size

        def public_bytes(fd):
            size = seal(fd)
            raw = os.pread(fd, size + 1, 0)
            _require(len(raw) == size, 'fixture-tls-material')
            return raw

        key, key_path = held()
        cert, cert_path = held()
        public, public_path = held()
        der, _ = held()
        openssl(['req', '-config', '/dev/null', '-x509', '-newkey', 'ec', '-pkeyopt',
                 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-sha256',
                 '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
                 '-addext', 'basicConstraints=critical,CA:FALSE',
                 '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=serverAuth',
                 '-keyout', key_path, '-out', cert_path], (key, cert))
        seal(key)
        certificate = ssl.PEM_cert_to_DER_cert(public_bytes(cert).decode('ascii'))
        _require(0 < len(certificate) <= _TLS_FILE_BYTES, 'fixture-tls-material')
        openssl(['x509', '-in', cert_path, '-pubkey', '-noout'], (cert,), public)
        seal(public)
        openssl(['pkey', '-pubin', '-in', public_path, '-outform', 'DER'], (public,), der)
        pin = base64.b64encode(hashlib.sha256(public_bytes(der)).digest()).decode('ascii')
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.num_tickets = 0
        context.set_alpn_protocols(['http/1.1'])
        context.load_cert_chain(cert_path, key_path)
        _remaining(deadline)
        return context, certificate, pin


def _tls_io(stream, action, deadline, stop=None):
    while True:
        if stop is not None and stop.is_set():
            raise _Stopped
        _remaining(deadline)
        try:
            return action()
        except ssl.SSLWantReadError:
            select.select([stream], [], [], min(_POLL, _remaining(deadline)))
        except ssl.SSLWantWriteError:
            select.select([], [stream], [], min(_POLL, _remaining(deadline)))


def _write(stream, data, deadline, stop=None):
    pending = memoryview(data)
    while pending:
        sent = _tls_io(stream, lambda: stream.send(pending), deadline, stop)
        _require(sent > 0, 'fixture-tls-write')
        pending = pending[sent:]


def _require_no_queued_request_data(stream, deadline):
    # SSL.pending only accounts for bytes already decrypted. Try the TLS
    # reader even when it reports zero; a queued partial record is also a
    # refusal. This is an observation before responding, not a future-byte
    # promise for a peer we do not control.
    _remaining(deadline)
    readable = bool(select.select([stream], [], [], 0)[0])
    try:
        stream.recv(1)
    except ssl.SSLWantReadError:
        _require(not readable, 'fixture-http-framing')
    else:
        raise FixtureRefusal('fixture-http-framing')
    _remaining(deadline)


def _require_empty_tcp_probe(stream, deadline, stop):
    while not stop.is_set():
        ready, _, _ = select.select([stream], [], [], min(_POLL, _remaining(deadline)))
        if ready:
            _remaining(deadline)
            _require(stream.recv(1) == b'', 'fixture-tcp-probe-data')
            return
    raise _Stopped


def _finish_probe_tls(stream, deadline, stop=None):
    # Only the independent peer participates in reciprocal authenticated TLS
    # shutdown. Closing Chromium's response socket is a separate witness.
    with _tls_io(stream, stream.unwrap, deadline, stop):
        _remaining(deadline)


def _open_listener(port):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.setblocking(False)
        listener.bind((LOOPBACK, port))
        listener.listen(2)
        return listener
    except BaseException:
        listener.close()
        raise


def _namespace():
    own, init = os.stat('/proc/self/ns/net'), os.stat('/proc/1/ns/net')
    identity = (own.st_dev, own.st_ino)
    _require(identity == (init.st_dev, init.st_ino), 'fixture-network-namespace')
    return identity


class CapabilityFixture:
    """Held listeners owned by one course and one bounded server thread."""

    def __init__(self, host, started):
        _require(type(started) in (int, float) and math.isfinite(started)
                 and 0 < started <= time.monotonic(), 'fixture-start-clock')
        self._host = host
        self._preparation, self._work, self._cleanup = started + 180, started + 255, started + 285
        self._namespace = None
        self._listeners = {}
        self._thread = None
        self._stop = threading.Event()
        self._changed = threading.Event()
        self._probe = threading.Event()
        self._browser = threading.Event()
        self._tcp_probe_clock = None
        self._tcp_probe_deadline = None
        self._tcp_probe_observed = False
        self._tcp_probe_confirmed = False
        self._crypto_child = None
        self._crypto_launch_uncertain = False
        self._crypto_files = None
        self._served = 0
        self._failed = False
        self._started = False
        self._closed = False
        self._verified_probe = False
        self._tls = None
        self._nonce = None
        self.certificate_der = None
        self.spki = None

    def _tables(self):
        _require(self._namespace is not None and _namespace() == self._namespace, 'fixture-network-namespace')
        return (self._host._bounded_file('/proc/net/tcp', 1024 * 1024),
                self._host._bounded_file('/proc/net/tcp6', 1024 * 1024))

    def _absent(self):
        tables = self._tables()
        _require(all(not self._host._listeners_on(*tables, port) for port in (INGRESS, TRIPWIRE)),
                 'fixture-port-absence')

    def _held(self, port, listener, inode):
        fd = listener.fileno()
        info = os.fstat(fd)
        _require(stat.S_ISSOCK(info.st_mode) and info.st_ino == inode
                 and os.readlink(f'/proc/self/fd/{fd}') == f'socket:[{inode}]'
                 and listener.family == socket.AF_INET and listener.getsockname() == (LOOPBACK, port)
                 and listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 1, 'fixture-listener-identity')

    def require_ready(self):
        _remaining(self._work)
        _require(not self._closed and not self._failed and self._thread is not None and self._thread.is_alive()
                 and self._listeners.keys() == {INGRESS, TRIPWIRE}, 'fixture-listener-unready')
        tables = self._tables()
        for port, (listener, inode) in self._listeners.items():
            self._held(port, listener, inode)
            _require(self._host.listener_inode(*tables, port, 0) == inode, 'fixture-listener-identity')
        _remaining(self._work)

    def _crypto_unsettled(self):
        return self._crypto_launch_uncertain or self._crypto_child is not None

    def _crypto_has_no_children(self):
        return not self._host._bounded_file(f'/proc/self/task/{os.getpid()}/children', 65536).strip()

    def _settle_crypto(self, preparation_deadline):
        child = self._crypto_child
        deadline = min(preparation_deadline, time.monotonic() + _CRYPTO_SETTLEMENT_SECONDS)
        try:
            _remaining(deadline)
            # The direct child is still unreaped, so its PID cannot identify a
            # replacement group. Both IDs come from its new private session.
            _require(child.returncode is None and os.getpgid(child.pid) == child.pid
                     and os.getsid(child.pid) == child.pid, 'fixture-crypto-settlement')
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            code = child.wait(timeout=_remaining(deadline))
            while True:
                _remaining(deadline)
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(min(_POLL, _remaining(deadline)))
            _require(self._crypto_has_no_children(), 'fixture-crypto-settlement')
            _remaining(deadline)
        except (OSError, subprocess.TimeoutExpired):
            raise FixtureRefusal('fixture-crypto-settlement') from None
        self._crypto_child = None
        return code

    def _run_crypto(self, arguments, inputs, output, env, deadline):
        # Called only by the three fixed OpenSSL commands during preparation.
        # prlimit execs the fixed tool; no child process or reaper may share
        # this owner. No numeric group signal is issued after leader reap.
        _require(not self._crypto_unsettled() and threading.current_thread() is threading.main_thread()
                 and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
                 and self._crypto_has_no_children(),
                 'fixture-crypto-owner')
        with os.scandir('/proc/self/task') as tasks:
            _require(next(tasks, None) is not None and next(tasks, None) is None, 'fixture-crypto-owner')
        stop = min(time.monotonic() + _CRYPTO_SECONDS, deadline - _CRYPTO_SETTLEMENT_SECONDS)
        _remaining(stop)
        self._crypto_launch_uncertain = True
        try:
            self._crypto_child = subprocess.Popen(
                ['/usr/bin/prlimit', f'--fsize={_TLS_FILE_BYTES}', '--', '/usr/bin/openssl', *arguments],
                env=env, pass_fds=inputs, stdin=subprocess.DEVNULL, close_fds=True, start_new_session=True,
                stdout=subprocess.DEVNULL if output is None else output, stderr=subprocess.DEVNULL,
            )
        except OSError:
            raise FixtureRefusal('fixture-tls-material') from None
        self._crypto_launch_uncertain = False
        try:
            while True:
                _remaining(stop)
                status = os.waitid(os.P_PID, self._crypto_child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if status is not None:
                    _require(status.si_pid == self._crypto_child.pid, 'fixture-crypto-settlement')
                    _remaining(stop)
                    break
                time.sleep(min(_POLL, _remaining(stop)))
        except BaseException as primary:
            try:
                self._settle_crypto(deadline)
            except BaseException:
                primary.add_note('fixture-crypto-settlement')
            raise
        _require(self._settle_crypto(deadline) == 0, 'fixture-tls-material')
        _remaining(deadline)

    def start(self):
        _require(not self._started and not self._closed and os.uname().sysname == 'Linux'
                 and os.getresuid() == (0, 0, 0) and os.getresgid() == (0, 0, 0), 'fixture-owner')
        self._started = True
        _remaining(self._preparation)
        self._namespace = _namespace()
        self._absent()
        self._tls, self.certificate_der, self.spki = _tls_context(self, self._preparation)
        self._nonce = secrets.token_hex(16).encode('ascii')
        for port in (INGRESS, TRIPWIRE):
            _remaining(self._preparation)
            listener = _open_listener(port)
            try:
                inode = os.fstat(listener.fileno()).st_ino
                self._listeners[port] = listener, inode
            except BaseException:
                listener.close()
                raise
        self._thread = threading.Thread(target=self._serve, name='aihr-browser-fixture', daemon=True)
        self._thread.start()
        self.require_ready()
        _remaining(self._preparation)

    def _serve_tls(self, raw, expected, deadline):
        _require(expected is not None, 'fixture-request-order')
        with self._tls.wrap_socket(raw, server_side=True, do_handshake_on_connect=False,
                                   suppress_ragged_eofs=False) as tls:
            _tls_io(tls, tls.do_handshake, deadline, self._stop)
            data = bytearray()
            while b'\r\n\r\n' not in data:
                block = _tls_io(tls, lambda: tls.recv(_HEADER_BYTES + 1 - len(data)), deadline, self._stop)
                _require(block and len(data) + len(block) <= _HEADER_BYTES, 'fixture-http-framing')
                data.extend(block)
            kind = _request_kind(bytes(data), self._nonce)
            _require(kind == expected, 'fixture-request-order')
            _require_no_queued_request_data(tls, deadline)
            _write(tls, _RESPONSE, deadline, self._stop)
            if kind == 'probe':
                _finish_probe_tls(tls, deadline, self._stop)

    def _serve(self):
        ingress, tripwire = (self._listeners[port][0] for port in (INGRESS, TRIPWIRE))
        try:
            while not self._stop.is_set():
                ready, _, _ = select.select([ingress, tripwire], [], [], min(_POLL, _remaining(self._work)))
                if tripwire in ready:
                    accepted, _ = tripwire.accept()
                    accepted.close()
                    raise FixtureRefusal('fixture-tripwire-connection')
                if ingress in ready:
                    raw, address = ingress.accept()
                    tcp_probe = self._served == 1 and not self._tcp_probe_observed
                    with raw:
                        _require(address[0] == LOOPBACK and self._served < 2, 'fixture-connection-census')
                        raw.setblocking(False)
                        deadline = min(self._work, time.monotonic() + _CONNECTION_SECONDS)
                        if tcp_probe:
                            _require(self._tcp_probe_deadline is not None, 'fixture-tcp-probe-order')
                            _require_empty_tcp_probe(raw, min(deadline, self._tcp_probe_deadline), self._stop)
                        else:
                            expected = 'probe' if self._served == 0 and self._probe.is_set() else (
                                'browser' if self._served == 1 and self._browser.is_set() else None)
                            self._serve_tls(raw, expected, deadline)
                    if tcp_probe:
                        self._tcp_probe_observed = True
                    else:
                        self._served += 1
                    self._changed.set()
        except BaseException:
            # The controlling owner sees only a boolean, never SSL or peer data.
            self._failed = True
            self._changed.set()

    def probe_ingress(self):
        self.require_ready()
        _require(not self._probe.is_set(), 'fixture-probe-repeat')
        deadline = min(self._preparation, time.monotonic() + _CONNECTION_SECONDS)
        _remaining(deadline)
        self._probe.set()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.set_alpn_protocols(['http/1.1'])
        context.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(self.certificate_der))
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM | socket.SOCK_CLOEXEC) as raw:
            raw.settimeout(_remaining(deadline))
            raw.connect((LOOPBACK, INGRESS))
            raw.setblocking(False)
            with context.wrap_socket(raw, server_hostname=LOOPBACK, do_handshake_on_connect=False,
                                     suppress_ragged_eofs=False) as tls:
                _tls_io(tls, tls.do_handshake, deadline)
                peer_der = tls.getpeercert(binary_form=True)
                _require(peer_der == self.certificate_der, 'fixture-peer-certificate')
                _write(tls, _REQUEST + _PROBE_HEADER + b': ' + self._nonce + b'\r\n\r\n', deadline)
                data = bytearray()
                while len(data) < len(_RESPONSE):
                    block = _tls_io(tls, lambda: tls.recv(len(_RESPONSE) - len(data)), deadline)
                    _require(block, 'fixture-probe-response')
                    data.extend(block)
                _require(bytes(data) == _RESPONSE
                         and _tls_io(tls, lambda: tls.recv(1), deadline) == b'', 'fixture-probe-response')
                _finish_probe_tls(tls, deadline)
        self._wait_served(1, deadline)
        self._verified_probe = True
        return INGRESS_URL, 200, INGRESS_BODY, peer_der

    def _wait_served(self, expected, deadline):
        while self._served < expected and not self._failed:
            self._changed.clear()
            if self._served < expected and not self._failed:
                self._changed.wait(min(_POLL, _remaining(deadline)))
        _require(not self._failed and self._served == expected, 'fixture-request-census')
        _remaining(deadline)

    def allow_browser_tcp_probe(self, clock):
        """Arm exactly the existing issuer deny-go counter window."""
        self.require_ready()
        _require(type(clock) is self._host.Deadline and self._verified_probe and self._served == 1
                 and self._tcp_probe_clock is None, 'fixture-tcp-probe-order')
        clock.remaining(_NEGATIVES_FRONTIER)
        self._tcp_probe_clock = clock
        self._tcp_probe_deadline = min(self._work, clock.start + _NEGATIVES_FRONTIER)
        _remaining(self._tcp_probe_deadline)

    def require_browser_tcp_probe(self, clock):
        """Called after the same issuer validates negatives-complete and its counter window."""
        _require(clock is self._tcp_probe_clock and self._tcp_probe_deadline is not None
                 and not self._tcp_probe_confirmed, 'fixture-tcp-probe-order')
        while not self._tcp_probe_observed and not self._failed:
            self._changed.clear()
            if not self._tcp_probe_observed and not self._failed:
                self._changed.wait(min(_POLL, _remaining(self._tcp_probe_deadline)))
        _require(self._tcp_probe_observed and not self._failed and self._served == 1, 'fixture-tcp-probe-order')
        clock.remaining(_NEGATIVES_FRONTIER)
        self.require_ready()
        _remaining(self._tcp_probe_deadline)
        self._tcp_probe_confirmed = True

    def allow_browser_request(self):
        self.require_ready()
        _require(self._verified_probe and self._tcp_probe_confirmed and self._served == 1 and not self._browser.is_set(),
                 'fixture-browser-admission')
        self._browser.set()

    def require_browser_response(self):
        _require(self._browser.is_set() and not self._closed, 'fixture-browser-admission')
        self._wait_served(2, self._work)
        self.require_ready()

    def close(self):
        _require(self._started and not self._closed, 'fixture-close-order')
        self._closed = True
        self._stop.set()
        if self._thread is not None and self._thread.ident is not None:
            self._thread.join(max(0, min(1, self._cleanup - time.monotonic())))
            _require(not self._thread.is_alive(), 'fixture-server-settlement')
        close_failed = False
        for port, (listener, inode) in self._listeners.items():
            try:
                self._held(port, listener, inode)
            except (FixtureRefusal, OSError):
                close_failed = True
                continue
            try:
                if select.select([listener], [], [], 0)[0]:
                    self._failed = True
            except (OSError, ValueError):
                self._failed = True
            finally:
                try:
                    listener.close()
                    close_failed |= listener.fileno() != -1
                except OSError:
                    close_failed = True
        self._tls = self._nonce = None
        _require(not close_failed, 'fixture-listener-settlement')
        _require(not self._crypto_unsettled() and self._crypto_files is None, 'fixture-crypto-settlement')
        self._absent()
        _remaining(self._cleanup)
        return {'listenersAbsent': True, 'serverHealthy': not self._failed}
