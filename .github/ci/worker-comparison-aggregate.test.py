"""Synthetic evidence controls for the parallel worker aggregate. No runner or application."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import ModuleType

path = Path(__file__).with_name('worker-comparison-aggregate.py')
owner = ModuleType('worker_comparison_aggregate')
owner.__file__ = str(path)
exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), owner.__dict__)

SHA = 'a' * 40
SEAL = {'buildId': 'model-build', 'entries': 9, 'bytes': 120, 'sha256': 'b' * 64}
ARCHIVE = 'c' * 64
HOST = {'effectiveCpus': 4, 'memoryBytes': 16 * 1024 ** 3, 'nodeVersion': 'v24.22.1', 'postgresProfile': 2,
        'cpuModel': 'AMD EPYC 7763 64-Core Processor', 'logicalCpus': 4, 'kernel': '6.11.0-1018-azure'}
HARNESS = {'harnessSha256': 'd' * 64, 'scenarioSha256': 'e' * 64}


def env(course='parallel-smoke', **extra):
    return {'AIHR_CI_HEAD': SHA, 'GITHUB_WORKFLOW_SHA': SHA, 'GITHUB_RUN_ID': '77', 'AIHR_MEASURED_BROWSER_COURSE': course,
            'AIHR_WORKER_BUILD_SEAL': json.dumps(SEAL), 'AIHR_WORKER_BUILD_ARCHIVE_SHA256': ARCHIVE,
            'WORKER_BUILD_RESULT': 'success', 'WORKER_CELL_RESULT': 'success', **extra}


def latency():
    row = {'samples': 10, 'p50Ms': 100, 'p95Ms': 200, 'p99Ms': 300, 'maxMs': 400}
    return {role: {work: dict(row) for work in owner.WORK} for role in owner.ROLES}


def observation(scope):
    locks = {'preflight': {'pass': True}, 'loaded': {'pass': scope == 'steady-500'}}
    return {'driver': {'identity': dict(HARNESS), 'complete': True, 'busyResponses': 0, 'pageEvents': {'qualifiedCrashes': 0},
                       'locks': locks},
            'workerCrashes': 0, 'browserErrors': 0, 'runtimeAcceptance': {'pass': True},
            'postgresWaitLog': {'retainedFailures': 0}, 'roleLatency': latency() if scope == 'steady-500' else None}


def cell(workers, course='parallel-smoke', **changes):
    name, scope = next((row[1], row[2]) for row in owner.COURSES[course] if row[0] == workers)
    value = {
        'kind': owner.KIND, 'releaseEligible': False, 'course': course,
        'identity': {'candidateSha': SHA, 'controllerSha': SHA, 'runId': 77, 'runAttempt': 1},
        'prerequisite': None if course == 'parallel-smoke' else {'source': SHA, 'runId': 5, 'harnessSha256': 'd' * 64},
        'frontiers': {}, 'buildSeal': SEAL, 'transport': {'seal': SEAL, 'archiveSha256': ARCHIVE, 'archiveBytes': 1000},
        'seedSettlement': 'settled', 'complete': True, 'host': dict(HOST), 'productionEquivalent': False, 'scope': 'x',
        'cell': {'name': name, 'scope': scope, 'state': 'passed', 'reason': None, 'fixtureDay': '2026-11-10',
                 'settlement': 'settled', 'observation': observation(scope)},
        'processOwner': {'settled': True, 'cellBarriers': 1, 'runnerExitCode': 0, 'exitedOutsideSession': 0},
    }
    for key, update in changes.items():
        if key == 'host':
            value['host'].update(update)
        elif key == 'cellState':
            value['cell'].update(update)
        else:
            value[key] = update
    return value


class AggregateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def publish(self, *cells):
        for value in cells:
            directory = self.root / ('worker-comparison-cell-' + value['cell']['name'].split('-')[-1])
            directory.mkdir()
            (directory / 'summary.json').write_text(json.dumps(value))
            (directory / 'summary.json').chmod(0o644)

    def test_three_passed_cells_on_matching_runners_complete(self):
        self.publish(cell('2'), cell('4'), cell('8', host={'kernel': '6.8.0-1'}))
        result = owner.aggregate(env(), self.root)
        self.assertTrue(result['complete'] and result['steadyPairPassed'])
        self.assertEqual(result['reasons'], [])
        self.assertEqual(result['steadyPair']['differences'], {})
        self.assertEqual(result['scalingComparison'], 'claimed')
        self.assertEqual([row['host']['cpuModel'] for row in result['cells']], [HOST['cpuModel']] * 3)

    def test_matched_runners_claim_the_scaling_comparison(self):
        full = 'parallel-2-4-8'
        self.publish(cell('2', full), cell('4', full), cell('8', full))
        result = owner.aggregate(env(full), self.root)
        self.assertTrue(result['complete'] and result['steadyPairPassed'])
        self.assertEqual(result['scalingComparison'], 'claimed')
        self.assertIsNone(result['steadyPair']['scalingNotClaimedReason'])
        self.assertEqual(result['steadyPair']['latency']['employee.read']['p95Ms'], [200, 200])

    def test_unmatched_cpu_model_passes_release_gates_without_any_scaling_number(self):
        full = 'parallel-2-4-8'
        other = 'Intel Xeon Platinum 8370C'
        self.publish(cell('2', full), cell('4', full, host={'cpuModel': other}), cell('8', full))
        result = owner.aggregate(env(full), self.root)
        self.assertTrue(result['complete'] and result['steadyPairPassed'])
        self.assertEqual(result['reasons'], [])
        self.assertEqual(result['scalingComparison'], 'not-claimed')
        self.assertEqual(result['steadyPair']['scalingNotClaimedReason'], 'cpu-model-differs')
        self.assertEqual(result['steadyPair']['cpuModels'], {'steady-2': HOST['cpuModel'], 'steady-4': other})
        self.assertNotIn('latency', result['steadyPair'])
        published = json.dumps(result) + owner.summary_markdown(result)
        self.assertNotIn('p95Ms', published)
        self.assertIn('not claimed', owner.summary_markdown(result))

    def test_mismatched_vcpu_fails_the_smaller_cell_and_claims_nothing(self):
        for change in ({'effectiveCpus': 2, 'logicalCpus': 2}, {'memoryBytes': 7 * 1024 ** 3}):
            with self.subTest(change=change):
                self.tearDown(); self.setUp()
                self.publish(cell('2'), cell('4', host=change), cell('8'))
                result = owner.aggregate(env(), self.root)
                self.assertFalse(result['complete'] or result['steadyPairPassed'])
                self.assertIn('smoke-4-gate-runner-class', result['reasons'])
                self.assertEqual(result['cells'][1]['gateFailures'], ['runner-class'])
                self.assertTrue(set(change) <= set(result['steadyPair']['differences']))

    def test_vcpu_difference_is_never_a_scaling_claim(self):
        self.publish(cell('2'), cell('4', host={'effectiveCpus': 2, 'logicalCpus': 2}), cell('8'))
        result = owner.aggregate(env(), self.root)
        self.assertEqual((result['scalingComparison'], result['steadyPair']['scalingNotClaimedReason']), ('not-claimed', 'vcpu-differs'))

    def test_any_cell_gate_fails_the_aggregate_whatever_the_cpu_models(self):
        full = 'parallel-2-4-8'
        def broken(path, value):
            changed = cell('8' if path[0] == 'eight' else '4', full, host={'cpuModel': 'Intel Xeon Platinum 8370C'})
            target = changed['cell']['observation']
            for key in path[1:-1]:
                target = target[key]
            target[path[-1]] = value
            return changed
        cases = (
            (('four', 'driver', 'busyResponses', 1), 'busy'),
            (('four', 'driver', 'pageEvents', 'qualifiedCrashes', 1), 'page-crashes'),
            (('four', 'workerCrashes', 2), 'worker-crashes'),
            (('four', 'browserErrors', 3), 'browser-errors'),
            (('four', 'driver', 'locks', 'preflight', 'pass', False), 'preflight-lock-sampler'),
            (('four', 'driver', 'locks', 'loaded', 'pass', False), 'loaded-lock-sampler'),
            (('four', 'runtimeAcceptance', 'pass', False), 'runtime-acceptance'),
            (('four', 'postgresWaitLog', 'retainedFailures', 1), 'database-lock-waits'),
            (('four', 'driver', 'complete', False), 'driver-complete'),
            (('eight', 'browserErrors', 1), 'browser-errors'),
        )
        for row, gate in cases:
            with self.subTest(row=row):
                self.tearDown(); self.setUp()
                bad = broken(row[:-1], row[-1])
                others = [cell(w, full) for w in ('2', '4', '8') if w != ('8' if row[0] == 'eight' else '4')]
                self.publish(bad, *others)
                result = owner.aggregate(env(full), self.root)
                self.assertFalse(result['complete'])
                name = 'functional-8' if row[0] == 'eight' else 'steady-4'
                self.assertIn(name + '-gate-' + gate, result['reasons'])
                if row[0] == 'four':
                    self.assertEqual(result['scalingComparison'], 'not-claimed')

    def test_memory_and_kernel_differences_are_reported_not_hidden(self):
        self.publish(cell('2'), cell('4', host={'memoryBytes': 16 * 1024 ** 3 - 4096, 'kernel': '6.8.0-1'}), cell('8'))
        result = owner.aggregate(env(), self.root)
        self.assertTrue(result['complete'])
        self.assertEqual(set(result['steadyPair']['differences']), {'memoryBytes', 'kernel'})
        self.assertIn('kernel', owner.summary_markdown(result))

    def test_missing_failed_or_foreign_build_cells_fail_the_aggregate(self):
        cases = (
            ((cell('2'), cell('4')), 'smoke-8-missing'),
            ((cell('2'), cell('4'), cell('8', complete=False, processOwner={'settled': True, 'cellBarriers': 1,
              'runnerExitCode': 1, 'exitedOutsideSession': 0}, cellState={'state': 'failed', 'reason': 'measurement'})), 'smoke-8-measurement'),
            ((cell('2'), cell('4', transport={'seal': dict(SEAL, sha256='f' * 64), 'archiveSha256': ARCHIVE,
              'archiveBytes': 1}, buildSeal=dict(SEAL, sha256='f' * 64)), cell('8')), 'smoke-4-refused'),
            ((cell('2'), cell('4', cellState={'fixtureDay': '2026-11-11'}), cell('8')), 'fixture-day'),
        )
        for cells, reason in cases:
            with self.subTest(reason=reason):
                self.tearDown(); self.setUp()
                self.publish(*cells)
                result = owner.aggregate(env(), self.root)
                self.assertFalse(result['complete'])
                self.assertIn(reason, result['reasons'])

    def test_failed_setup_phase_is_named_publicly(self):
        failed = cell('2', complete=False, buildSeal=None, seedSettlement=None,
                      processOwner={'settled': True, 'cellBarriers': 0, 'runnerExitCode': 1, 'exitedOutsideSession': 0},
                      cellState={'state': 'failed', 'reason': 'build-proof', 'fixtureDay': None, 'observation': {
                          'phaseStatus': [{'label': 'postgres', 'exitCode': 2, 'timedOut': False}]}})
        self.publish(failed, cell('4'), cell('8'))
        result = owner.aggregate(env(), self.root)
        self.assertEqual(result['cells'][0]['failedPhase'], 'postgres')
        self.assertIsNone(result['cells'][1]['failedPhase'])

    def test_failed_upstream_jobs_fail_even_with_every_summary(self):
        self.publish(cell('2'), cell('4'), cell('8'))
        result = owner.aggregate(env(WORKER_CELL_RESULT='failure'), self.root)
        self.assertFalse(result['complete'])
        self.assertIn('cell-jobs-failure', result['reasons'])
        result = owner.aggregate(env(AIHR_WORKER_BUILD_SEAL=''), self.root)
        self.assertIn('build-transport-unavailable', result['reasons'])

    def test_full_course_requires_one_prerequisite_and_one_harness(self):
        full = 'parallel-2-4-8'
        other = cell('4', full)
        other['cell']['observation']['driver']['identity']['scenarioSha256'] = '0' * 64
        self.publish(cell('2', full), other, cell('8', full))
        result = owner.aggregate(env(full), self.root)
        self.assertIn('harness-differs', result['reasons'])
        self.assertEqual((result['scalingComparison'], result['steadyPair']['scalingNotClaimedReason']), ('not-claimed', 'harness-differs'))
        self.assertNotIn('latency', result['steadyPair'])
        self.assertEqual([row['name'] for row in result['cells']], ['steady-2', 'steady-4', 'functional-8'])
        with self.assertRaises(owner.Refused):
            owner.check_cell(cell('2', full, prerequisite=None), full, '2', owner.expected_identity(env(full)))

    def test_complete_without_settled_owner_proof_is_refused(self):
        forged = cell('2', processOwner={'settled': True, 'cellBarriers': 0, 'runnerExitCode': 0, 'exitedOutsideSession': 0})
        with self.assertRaises(owner.Refused):
            owner.check_cell(forged, 'parallel-smoke', '2', owner.expected_identity(env()))

    def test_verify_cell_binds_owner_digest_and_outcome(self):
        temp = self.root / 'runner'
        evidence = temp / 'system-worker-comparison-evidence'
        evidence.mkdir(parents=True, mode=0o700)
        evidence.chmod(0o700)
        raw = json.dumps(cell('4')).encode()
        (evidence / 'summary.json').write_bytes(raw)
        (evidence / 'summary.json').chmod(0o600)
        output = self.root / 'output'
        output.write_text('')
        base = env(RUNNER_TEMP=str(temp), GITHUB_OUTPUT=str(output), CELL_WORKERS='4',
                   CELL_SUMMARY_SHA256=hashlib.sha256(raw).hexdigest(), CELL_OUTCOME='success')
        owner.verify_cell(base)
        self.assertEqual(output.read_text(), 'owned_summary=true\n')
        for change in ({'CELL_SUMMARY_SHA256': '0' * 64}, {'CELL_OUTCOME': 'failure'}, {'CELL_WORKERS': '2'}):
            with self.assertRaises(owner.Refused):
                owner.verify_cell({**base, **change})

    def test_main_writes_bounded_aggregate_and_exit_status(self):
        self.publish(cell('2'), cell('4'), cell('8'))
        out = self.root / 'aggregate' / 'aggregate.json'
        summary = self.root / 'summary.md'
        self.assertEqual(owner.main(['x', 'aggregate', str(self.root), str(out)], env(GITHUB_STEP_SUMMARY=str(summary))), 0)
        self.assertTrue(json.loads(out.read_text())['complete'])
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)
        self.assertIn('smoke-4', summary.read_text())
        self.assertEqual(owner.main(['x', 'aggregate', str(self.root), str(out)], env()), 1)


if __name__ == '__main__':
    unittest.main()
