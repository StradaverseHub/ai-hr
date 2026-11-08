"""Pure closed-route/budget models + real tiny Linux owner-death controls.
No compiler, application, DB, provider or forged normal-CI environment runs.
"""
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import ModuleType

SOURCE = Path(__file__).with_name('compiler-reference-supervisor.py').resolve()
M = ModuleType('compiler_supervisor_control');M.__file__ = str(SOURCE)
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec', dont_inherit=True), M.__dict__)


class CompilerSupervisorControls(unittest.TestCase):
    def test_closed_command_uses_exact_nodb_config_and_refuses_sql_or_crosspurpose(self):
        args = M.fixed_command('compiler-reference', Path('/owned/node'), Path('/owned/controller'), Path('/owned/evidence'))
        self.assertEqual(args, ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.nodb.config.ts', M.FILE,
            '--reporter=default', '--reporter=json', '--outputFile.json=/owned/evidence/nodb.vitest.json'])
        for stage in ('reset', 'migrate', 'stop', 'benchmark', 'native-factory', 'ascii-purpose', 'arbitrary'):
            with self.assertRaises(ValueError):
                M.fixed_command(stage, Path('/owned/node'), Path('/owned/controller'), Path('/owned/evidence'))

    def test_actual_job_envelope_requires_full848_plus120_tail_and6_settlement(self):
        env = {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'AIHR_FOCUSED_JOB_MONOTONIC_NS': '100000000000'}
        anchor = {'version': 1, 'run': '123', 'attempt': '1', 'job': 'selected-tests', 'bootId': 'owned-model',
                  'startNs': '100000000000', 'wallTimeNs': '1234567890000000000'}
        seconds, elapsed = M.job_budget('compiler-reference', anchor, env, 'owned-model', 200)
        self.assertEqual((seconds, elapsed), (848, 100))
        with self.assertRaises(ValueError):
            M.job_budget('compiler-reference', anchor, env, 'owned-model', 297)
        for stage in ('git-head', 'git-status', 'git-tracked', 'controller-head', 'controller-status', 'classifier'):
            self.assertEqual(M.job_budget(stage, anchor, env, 'owned-model', 200)[0], M.LIMITS[stage])

    def test_anchor_refuses_crossrun_future_boot_or_bool_version_before_any_command(self):
        env = {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'AIHR_FOCUSED_JOB_MONOTONIC_NS': '100000000000'}
        base = {'version': 1, 'run': '123', 'attempt': '1', 'job': 'selected-tests', 'bootId': 'owned-model',
                'startNs': '100000000000', 'wallTimeNs': '1234567890000000000'}
        for change in ({'version': True}, {'run': '456'}, {'bootId': 'foreign'}, {'startNs': '300000000000'}, {'extra': True}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                M.job_budget('compiler-reference', dict(base, **change), env, 'owned-model', 200)

    def native_parent(self, dies):
        self.assertEqual(sys.platform, 'linux');node = os.environ['AIHR_BENCHMARK_TEST_NODE']
        self.assertEqual(M._kernel.own_children(), [])
        previous = M._kernel.subreaper(True)
        with tempfile.TemporaryDirectory(prefix='compiler-owner-native-') as directory:
            root = Path(directory);report = root / 'report.json';child_identity = root / 'child.json'
            runner = root / 'runner.py'
            runner.write_text('''import json,os,sys,time
from pathlib import Path
from types import ModuleType
assert sys.stdin.buffer.read(1)==b'A'
source=Path(sys.argv[1]);module=ModuleType('actual_parent_watch');module.__file__=str(source)
exec(compile(source.read_bytes(),str(source),'exec',dont_inherit=True),module.__dict__)
events=[]
child="import json,os,signal,sys,time; from pathlib import Path; text=Path('/proc/self/stat').read_text(); fields=text[text.rindex(')')+2:].split(); Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'start':int(fields[19])})); signal.signal(signal.SIGTERM,signal.SIG_IGN); print('CHILD_LIVE',flush=True); time.sleep("+('10'if sys.argv[4]=='die'else'.05')+")"
result=module.supervise_parent([sys.executable,'-I','-B','-c',child,sys.argv[3]],2,events.append,parent=os.getppid())
Path(sys.argv[2]).write_text(json.dumps({'result':result,'events':events}))
''')
            owner_script = root / 'owner.cjs'
            owner_script.write_text('''const{spawn}=require('node:child_process');
const p=spawn('/usr/bin/python3',['-I','-B',process.argv[2],process.argv[3],process.argv[4],process.argv[5],process.argv[6]],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
process.stdout.write(JSON.stringify({pid:p.pid})+'\\n');let text='';
process.stdin.once('data',value=>{if(value.toString()!=='A')process.exit(91);p.stdin.end('A');});
p.stdout.on('data',chunk=>{text+=chunk;if(text.includes('CHILD_LIVE')&&process.argv[6]==='die')process.exit(0);});
p.on('close',code=>process.exit(code??1));setTimeout(()=>process.exit(90),5000);
''')
            owner, descriptor, adopted = None, None, None
            failures = []
            try:
                owner = subprocess.Popen([node, str(owner_script), str(runner), str(SOURCE), str(report), str(child_identity), 'die' if dies else 'alive'],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env={'PATH': '/usr/bin:/bin'})
                self.assertTrue(select.select([owner.stdout], [], [], 5)[0])
                packet = json.loads(owner.stdout.readline(128));self.assertEqual(set(packet), {'pid'})
                adopted = packet['pid'];descriptor = os.pidfd_open(adopted);before = M.identity(adopted)
                self.assertEqual(before['parent'],owner.pid);owner.stdin.write(b'A');owner.stdin.flush()
                self.assertEqual(owner.wait(timeout=5), 0)
                if dies:
                    until = time.monotonic() + 5
                    while os.waitid(os.P_PID, adopted, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None and time.monotonic() < until:
                        time.sleep(.01)
                    self.assertIsNotNone(os.waitid(os.P_PID, adopted, os.WEXITED | os.WNOHANG | os.WNOWAIT))
                    self.assertEqual(os.waitpid(adopted, 0)[0], adopted);adopted = None
                value = json.loads(report.read_text());result = value['result']
                self.assertEqual(result['reason'], 'owner-interrupted' if dies else 'complete')
                self.assertTrue(result['groupQuiescent'] and result['reaped']);self.assertFalse(result['escapedSession'])
                kinds = [event['kind'] for event in value['events']]
                self.assertLess(kinds.index('group-stop-before-reap'), kinds.index('group-quiescent-then-reaped'))
                child = json.loads(child_identity.read_text())
                try:
                    current = M.identity(child['pid'])
                except FileNotFoundError:
                    pass
                else:
                    self.assertNotEqual(current['start'], child['start'], 'Actual resistant child remains')
                self.assertEqual(M._kernel.own_children(), [])
            except BaseException as error:
                failures.append(error)
            finally:
                if owner is not None:
                    if owner.poll() is None:
                        owner.terminate()
                        try:
                            owner.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            owner.kill();owner.wait(timeout=1)
                    owner.stdin.close();owner.stdout.close();owner.stderr.close()
                # Cleanup only actual adopted descendants using the SAME owned
                # kernel's pidfd/WNOWAIT primitive; no numeric recovery/group kill.
                try:
                    settled, _escaped = M._kernel.settle_adopted(-1, time.monotonic()+3, time.monotonic)
                    self.assertTrue(settled);self.assertEqual(M._kernel.own_children(), [])
                    M._kernel.subreaper(previous)
                except BaseException as error:
                    failures.append(error)
                if descriptor is not None:
                    try:
                        os.close(descriptor)
                    except BaseException as error:
                        failures.append(error)
                if failures:
                    raise BaseExceptionGroup('Native parent-watch control or ownership cleanup refused', failures)

    def test_real_parent_stays_alive_and_resistant_child_closes_normally(self):
        self.native_parent(False)

    def test_real_parent_death_interrupts_kernel_and_cleans_resistant_child_before_reap(self):
        self.native_parent(True)

    def test_actual_adapter_uses_one_source_kernel_and_no_alarm_or_arbitrary_process_loop(self):
        self.assertEqual(Path(M._kernel.__file__).resolve(), SOURCE.with_name('owned-process.py'))
        self.assertEqual(M._kernel.supervise.__code__.co_filename, str(SOURCE.with_name('owned-process.py')))
        source = SOURCE.read_text();self.assertNotIn('SIGALRM', source);self.assertNotIn('setitimer(', source)
        self.assertNotIn('def supervise(', source);self.assertNotIn('os.killpg(', source)


if __name__ == '__main__':
    unittest.main()
