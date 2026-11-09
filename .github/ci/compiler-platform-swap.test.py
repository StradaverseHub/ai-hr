"""Model closed compiler swap controls without reading or changing host swap."""
from contextlib import ExitStack, redirect_stdout
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import runpy
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

loaded = runpy.run_path(str(Path(__file__).with_name('compiler-memory-feasibility.py')))
model = loaded['platform_swap'].__globals__
Refusal = model['Refusal']
CAP, SWAP, USABLE, RESERVE = (model[key] for key in ('LIMIT', 'SWAP', 'PLATFORM_SWAP_USABLE', 'SWAP_HOST_RESERVE'))
CONTROLLER = 'a' * 40
RUN = '42647755570'
UNIT = model['unit_name'](RUN)
HEADER = 'Filename Type Size Used Priority\n'
ACTIVE = '/swapfile file 3145724 0 -1'


class PlatformFile:
    def __init__(self):
        self.info = SimpleNamespace(st_dev=7, st_ino=8, st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0,
                                    st_nlink=1, st_size=model['PLATFORM_SWAP_BYTES'], st_mtime_ns=9, st_ctime_ns=10)

    def lstat(self):
        return self.info

    def resolve(self, *, strict):
        assert strict
        return self

    def __str__(self):
        return '/swapfile'


class PlatformModel(unittest.TestCase):
    def setUp(self):
        self.file = PlatformFile()
        self.rows = HEADER + ACTIVE
        hooks = patch.dict(model, {'PLATFORM_SWAP': self.file, 'read_at': self.read})
        hooks.start()
        self.addCleanup(hooks.stop)

    def read(self, directory, name, maximum):
        self.assertEqual((directory, name, maximum), (None, '/proc/swaps', 16384))
        return self.rows

    def test_observed_platform_and_live_floor_are_exact(self):
        birth = model['platform_swap'](initial=True)
        self.assertEqual(birth, list(model['identity'](self.file.info)))
        allowed = (USABLE - RESERVE) // 1024
        self.rows = HEADER + ACTIVE.replace(' 0 ', f' {allowed} ')
        self.assertEqual(model['platform_swap'](birth), birth)
        with self.assertRaisesRegex(Refusal, 'platform-swap-preused'):
            model['platform_swap'](birth, initial=True)
        self.rows = HEADER + ACTIVE.replace(' 0 ', f' {allowed + 1} ')
        with self.assertRaisesRegex(Refusal, 'host-swap-headroom'):
            model['platform_swap'](birth)

    def test_foreign_absent_and_changed_inventory_refuses(self):
        for rows in (HEADER.strip(), HEADER + ACTIVE + '\n/foreign file 1 0 -2',
                     HEADER + ACTIVE.replace('/swapfile', '/foreign'), HEADER + ACTIVE.replace(' file ', ' partition '),
                     HEADER + ACTIVE.replace('3145724', '3145728'), HEADER + ACTIVE.replace('-1', '-2'),
                     HEADER + ACTIVE.replace(' 0 ', ' -1 ')):
            with self.subTest(rows=rows):
                self.rows = rows
                with self.assertRaises(Refusal):
                    model['platform_swap'](initial=True)

    def test_replaced_nonprivate_or_nonregular_identity_refuses(self):
        birth = model['platform_swap'](initial=True)
        with patch.object(self.file.info, 'st_ino', 11):
            with self.assertRaisesRegex(Refusal, 'platform-swap-identity'):
                model['platform_swap'](birth)
        changed = SimpleNamespace(**vars(self.file.info))
        changed.st_ctime_ns += 1
        with patch.object(self.file, 'lstat', side_effect=(self.file.info, changed)):
            with self.assertRaisesRegex(Refusal, 'platform-swap-identity'):
                model['platform_swap']()
        for key, value in (('st_mode', stat.S_IFREG | 0o640), ('st_mode', stat.S_IFLNK | 0o600),
                           ('st_uid', 501), ('st_nlink', 2), ('st_size', USABLE)):
            with self.subTest(key=key, value=value):
                with patch.object(self.file.info, key, value):
                    with self.assertRaisesRegex(Refusal, 'platform-swap-file'):
                        model['platform_swap']()


class ServiceIdentityModel(unittest.TestCase):
    def setUp(self):
        resources = ExitStack()
        self.addCleanup(resources.close)
        temporary = Path(resources.enter_context(tempfile.TemporaryDirectory())).resolve()
        (temporary / model['DIRECTORY']).mkdir(mode=0o700)
        resources.enter_context(patch.dict(os.environ, {'RUNNER_TEMP': str(temporary)}))
        self.process = Mock(side_effect=Refusal('process-not-live'))
        resources.enter_context(patch.dict(model, {'process_identity': self.process}))

    def refusal(self, unit, reason):
        output = StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(Refusal, reason):
            model['service'](unit, 0)
        self.assertEqual(output.getvalue(), f'F identity {reason}\n')

    def test_parent_generated_unit_reaches_service_process_proof(self):
        self.refusal(model['unit_name'](RUN), 'process-not-live')
        self.process.assert_called_once_with(os.getpid(), model['unit_name'](RUN))

    def test_predecessor_foreign_and_malformed_units_refuse_before_process_probe(self):
        for unit in (f'aihr-compiler-12800-swap-{RUN}.service', f'foreign-{RUN}.service',
                     model['unit_name']('0'), model['unit_name']('0123'),
                     model['unit_name']('1' * 17), model['unit_name']('1/foreign'),
                     model['unit_name'](RUN) + '.foreign', model['unit_name'](RUN) + '\n'):
            with self.subTest(unit=unit):
                self.refusal(unit, 'service-identity')
        self.process.assert_not_called()

    def test_relative_and_symlinked_owner_paths_refuse_before_process_probe(self):
        with patch.dict(os.environ, {'RUNNER_TEMP': 'relative'}):
            self.refusal(model['unit_name'](RUN), 'service-identity')
        with tempfile.TemporaryDirectory() as scratch:
            temporary = Path(scratch).resolve()
            foreign = temporary / 'foreign'
            foreign.mkdir()
            (temporary / model['DIRECTORY']).symlink_to(foreign)
            with patch.dict(os.environ, {'RUNNER_TEMP': str(temporary)}):
                self.refusal(model['unit_name'](RUN), 'service-identity')
        self.process.assert_not_called()


class SettlementModel(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.temp = Path(self.resources.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.directory = self.temp / model['DIRECTORY']
        self.directory.mkdir(mode=0o700)
        self.cgroup = self.temp / 'cgroup'
        self.output = self.temp / 'output'
        self.birth = list(model['identity'](PlatformFile().info))
        self.context = model['run_identity'](CONTROLLER, RUN)
        self.platform = self.directory / 'platform-swap.json'
        model['own_json'](self.platform, {**self.context, 'birth': self.birth})
        self.resources.enter_context(patch.dict(model, {'ROOT': self.cgroup, 'show': lambda _: {'LoadState': 'not-found'},
                                                       'process_birth': lambda _: None, 'platform_swap': self.check_swap}))
        self.resources.enter_context(patch.dict(os.environ, {'GITHUB_OUTPUT': str(self.output)}))

    def check_swap(self, birth):
        if birth != self.birth:
            raise Refusal('platform-swap-identity')
        return birth

    def receipt(self, **overrides):
        model['own_json'](self.directory / 'receipt.json', {
            'kind': 'WHOLE_COMPILER_PLATFORM_SWAP_FEASIBILITY_NOT_RELEASE', 'candidateSha': model['SOURCE'],
            'candidateTree': model['SOURCE_TREE'], 'controllerSha': CONTROLLER, 'runId': RUN, 'attempt': 1,
            'releaseEligible': False, 'complete': True, 'platformSwapVerified': True, 'platformSwapPreserved': True,
            'workSeconds': model['WORK_SECONDS'], 'progressSeconds': model['PROGRESS_SECONDS'],
            'progress': [progress_row('start'), progress_row('terminal', elapsed=1)],
            'platformSwapBirthSha256': hashlib.sha256(json.dumps(self.birth).encode('ascii')).hexdigest(), **overrides})

    def settle(self):
        model['independent_cleanup'](self.temp, self.temp, CONTROLLER, RUN)

    def test_settlement_requires_quiescence_and_publishes_closed_witness(self):
        self.receipt()
        raw = self.directory / 'compiler.raw.log'
        model['own_json'](raw, {'private': 'raw'})
        with model['owner_lock'](self.directory):
            with self.assertRaises(BlockingIOError):
                self.settle()
        active = self.cgroup / 'system.slice' / UNIT
        active.mkdir(parents=True)
        with self.assertRaisesRegex(Refusal, 'swap-service-live'):
            self.settle()
        self.assertTrue(raw.exists())
        active.rmdir()
        self.settle()
        self.assertFalse(raw.exists())
        self.assertTrue(self.platform.exists())
        self.assertEqual(self.output.read_text(), 'settled=true\n')
        receipt = json.loads((self.directory / 'swap-settlement.json').read_text())
        self.assertTrue(receipt['platformSwapIdentityVerified'])
        self.assertFalse(receipt['releaseEligible'])

    def test_unsettled_launch_and_live_manager_never_settle(self):
        pending = self.directory / 'manager-start.pending'
        model['own_json'](pending, self.context)
        with self.assertRaisesRegex(Refusal, 'swap-manager-unsettled'):
            self.settle()
        pending.unlink()
        model['own_json'](self.directory / 'manager-birth.json', {**self.context, 'pid': 100, 'birth': 200})
        with patch.dict(model, {'process_birth': lambda _: 200}):
            with self.assertRaisesRegex(Refusal, 'swap-manager-live'):
                self.settle()
        self.assertFalse(self.output.exists())

    def test_changed_platform_cleans_raw_without_admitting_upload(self):
        raw = self.directory / 'manager.raw.log'
        model['own_json'](raw, {'private': 'raw'})
        self.birth = [0] * 9
        with self.assertRaisesRegex(Refusal, 'platform-swap-identity'):
            self.settle()
        self.assertFalse(raw.exists())
        self.assertFalse(self.output.exists())
        self.assertTrue(self.platform.exists())

    def test_missing_or_mismatched_witness_never_certifies_success(self):
        self.receipt(platformSwapBirthSha256='0' * 64)
        with self.assertRaisesRegex(Refusal, 'platform-swap-witness'):
            self.settle()
        self.platform.unlink()
        with self.assertRaisesRegex(Refusal, 'platform-swap-witness'):
            self.settle()
        self.assertFalse(self.output.exists())

    def test_malformed_telemetry_refuses_artifact_settlement(self):
        self.receipt(progress=[progress_row('start', foreign='raw')])
        with self.assertRaisesRegex(Refusal, 'compiler-progress-witness'):
            self.settle()
        self.assertFalse(self.output.exists())

    def test_preflight_refusal_can_retain_closed_failure_without_platform_witness(self):
        self.platform.unlink()
        self.receipt(complete=False, platformSwapVerified=False, platformSwapPreserved=False, progress=[])
        self.settle()
        receipt = json.loads((self.directory / 'swap-settlement.json').read_text())
        self.assertFalse(receipt['platformSwapIdentityVerified'])
        self.assertEqual(receipt['platformSwapBirthSha256'], None)


def progress_row(phase, *, elapsed=0, **overrides):
    counters = {key: 0 for key in (*model['PROGRESS_COUNTERS'], *model['PROGRESS_GAUGES'])}
    return {'phase': phase, 'elapsedMs': elapsed, **counters,
            'throttledPeriods': None, 'throttledUsec': None, **overrides}


class ProgressModel(unittest.TestCase):
    def test_native_cgroup_counters_are_closed_and_raw_fields_are_omitted(self):
        zero_pressure = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0'
        values = {'cpu.stat': 'usage_usec 250\nuser_usec 200\nsystem_usec 50\nunknown_kernel_counter 100',
                  'cpu.pressure': zero_pressure, 'io.pressure': zero_pressure}
        memory = {'pressureMicros': {'full': 2}, 'current': 4096, 'peak': 8192,
                  'swapCurrent': 0, 'swapPeak': 0, 'memAvailable': 15 * model['GIB']}
        with patch.dict(model, {'read_at': lambda _, key: values[key]}):
            row = model['compiler_progress'](2, 1, 'start', memory)
            self.assertTrue(model['valid_progress']([row]))
            self.assertEqual((row['cpuUsec'], row['userUsec'], row['systemUsec']), (250, 200, 50))
            self.assertNotIn('unknown_kernel_counter', row)
            self.assertIsNone(row['throttledUsec'])
            values['cpu.stat'] += '\nnr_throttled 1\nthrottled_usec 2'
            row = model['compiler_progress'](2, 1, 'start', memory)
            self.assertEqual((row['throttledPeriods'], row['throttledUsec']), (1, 2))
            values['cpu.stat'] += '\nusage_usec 1'
            with self.assertRaisesRegex(Refusal, 'kernel-duplicate'):
                model['compiler_progress'](2, 1, 'start', memory)
            values['cpu.stat'] = 'usage_usec 250\nuser_usec 200\nsystem_usec 50\nnr_throttled 1'
            with self.assertRaisesRegex(Refusal, 'compiler-cpu-counters'):
                model['compiler_progress'](2, 1, 'start', memory)
            values['cpu.stat'] = 'usage_usec 250\nuser_usec 200\nsystem_usec 50'
            values['io.pressure'] = 'foreign'
            with self.assertRaisesRegex(Refusal, 'cgroup-pressure'):
                model['compiler_progress'](2, 1, 'start', memory)

    def test_timeline_rejects_unbounded_nonmonotonic_or_foreign_evidence(self):
        start = progress_row('start', cpuUsec=10)
        running = progress_row('running', elapsed=30000, cpuUsec=20, ioSomeUsec=4)
        terminal = progress_row('terminal', elapsed=30001, cpuUsec=21, ioSomeUsec=4)
        deadline = {**terminal, 'phase': 'deadline', 'elapsedMs': 1080100}
        self.assertTrue(model['valid_progress']([start, running, terminal]))
        self.assertTrue(model['valid_progress']([start, running, deadline]))
        self.assertTrue(model['valid_progress']([]))
        for rows in ([start] * (model['PROGRESS_MAX_ROWS'] + 1), [running], [start, terminal, running],
                     [start, {**running, 'elapsedMs': 29999}], [start, {**running, 'cpuUsec': 9}],
                     [start, running, {**terminal, 'ioSomeUsec': 3}],
                     [start, {**running, 'throttledUsec': 1}],
                     [start, {**running, 'throttledUsec': 1, 'throttledPeriods': 1}],
                     [start, {**running, 'swapPeakBytes': SWAP + 1}], [start, {**running, 'foreign': 'raw'}],
                     [start, {**deadline, 'elapsedMs': 1079999}], [start, {**deadline, 'elapsedMs': 1081001}],
                     [start, {**deadline, 'phase': 'terminal'}]):
            with self.subTest(rows=rows):
                self.assertFalse(model['valid_progress'](rows))


class KernelModel(unittest.TestCase):
    def setUp(self):
        self.values = {
            (2, 'memory.max'): str(CAP), (2, 'memory.swap.max'): str(SWAP), (2, 'memory.oom.group'): '1',
            (2, 'memory.swap.current'): '0', (2, 'memory.swap.peak'): '0',
            (2, 'memory.swap.events'): 'high 0\nmax 0\nfail 0',
            (2, 'memory.pressure'): 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0',
            (2, 'memory.current'): '4096', (2, 'memory.peak'): '4096',
            (2, 'memory.events.local'): 'oom 0\noom_kill 0\noom_group_kill 0',
            (1, 'memory.max'): 'max', (1, 'memory.swap.max'): 'max',
            (1, 'memory.events.local'): 'oom 0\noom_kill 0\noom_group_kill 0',
            (None, '/proc/vmstat'): 'oom_kill 0',
        }
        def read(fd, path):
            try:
                return self.values[fd, path]
            except KeyError as error:
                raise FileNotFoundError from error
        self.host = {'MemTotal': 16 * model['GIB'], 'MemAvailable': 15 * model['GIB'],
                     'SwapTotal': USABLE, 'SwapFree': USABLE}
        self.hooks = patch.dict(model, {'read_at': read, 'ram': lambda: self.host})
        self.hooks.start()
        self.addCleanup(self.hooks.stop)

    def test_kernel_caps_and_nonzero_swap_sampling(self):
        self.assertEqual(model['sample']([0, 1, 2], initial=True)['swapPeak'], 0)
        self.values[2, 'memory.swap.current'] = '4096'
        self.values[2, 'memory.swap.peak'] = '8192'
        row = model['sample']([0, 1, 2])
        self.assertEqual((row['swapCurrent'], row['swapPeak']), (4096, 8192))

    def test_wrong_caps_and_ancestor_headroom_refuse(self):
        for name, value, error in (
                ('memory.max', CAP + 1, 'cgroup-cap-readback'),
                ('memory.swap.max', SWAP - 1, 'cgroup-cap-readback'),
                ('memory.swap.peak', SWAP + 1, 'cgroup-swap')):
            with self.subTest(name=name):
                with patch.dict(self.values, {(2, name): str(value)}):
                    with self.assertRaisesRegex(Refusal, error):
                        model['sample']([0, 1, 2])
        with patch.dict(self.values, {(1, 'memory.swap.max'): '4096', (1, 'memory.swap.current'): '0'}):
            with self.assertRaisesRegex(Refusal, 'ancestor-swap-headroom'):
                model['sample']([0, 1, 2], initial=True)

    def test_low_host_swap_floor_or_missing_native_pressure_refuses(self):
        with patch.dict(self.host, {'SwapFree': RESERVE - 4096}):
            with self.assertRaisesRegex(Refusal, 'cgroup-swap'):
                model['sample']([0, 1, 2])
        with patch.dict(self.values, {(2, 'memory.pressure'): 'unknown'}):
            with self.assertRaisesRegex(Refusal, 'cgroup-pressure'):
                model['sample']([0, 1, 2])
        with patch.dict(self.values, {(2, 'memory.swap.events'): 'high 0\nmax 0\nfail 1'}):
            with self.assertRaisesRegex(Refusal, 'cgroup-swap-failed'):
                model['sample']([0, 1, 2])

    def test_invalid_terminal_never_becomes_complete(self):
        valid = dict(admitted=True, grantSent=True, compilerExit=0, managerExit=0, zeroObservedOom=True,
                     ownedCleanup='settled', platformSwapVerified=True, platformSwapPreserved=True,
                     generatedTypesVerified=True, sourceReverified=True,
                     compilerLog={'bytes': 1, 'sha256': '0' * 64}, v8HeapFatalMarker=False,
                     typescriptDiagnosticCount=0, progress=[progress_row('start'), progress_row('terminal', elapsed=1)],
                     initial=model['sample']([0, 1, 2], initial=True),
                     terminal=model['sample']([0, 1, 2]))
        deadline = time.monotonic_ns() + 100 * 10 ** 9
        self.assertTrue(model['accepted_terminal'](valid, deadline))
        for extra in ({'compilerExit': 2}, {'compilerExit': False}, {'platformSwapPreserved': False},
                      {'v8HeapFatalMarker': True}, {'typescriptDiagnosticCount': 1}, {'terminal': None},
                      {'sourceReverified': False}, {'compilerLog': {'bytes': 1}},
                      {'progress': []}, {'progress': [progress_row('start')]},
                      {'progress': [progress_row('start'), progress_row('deadline', elapsed=1080000)]},
                      {'terminal': {**valid['terminal'], 'swapPeak': SWAP + 1}},
                      {'terminal': {**valid['terminal'], 'swapEvents': {'fail': 1}}},
                      {'terminal': {**valid['terminal'], 'oom': {'oom': 1}}}):
            with self.subTest(extra=extra):
                self.assertFalse(model['accepted_terminal']({**valid, **extra}, deadline))
        self.assertFalse(model['accepted_terminal'](valid, time.monotonic_ns() - 1))


if __name__ == '__main__':
    unittest.main()
