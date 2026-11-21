import sys
sys.dont_write_bytecode=True
import importlib.util
import json
from pathlib import Path
import tempfile
import socket
import socketserver
import threading
import os
import datetime
import subprocess
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('broker',Path(__file__).resolve().parents[2]/'deploy/runner-control/broker.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
CATALOG=json.loads(Path(b.__file__).with_name('catalog.json').read_text())
class RunnerControlTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.policy={'environment':'staging','webUid':1234,'jobs':{'reviews':{'managed':True,'note':''}}}
        self.current={'revision':'a'*64,'managed':True,'installed':True,'hold':False,'running':False}
        self.request={'op':'configure','id':'reviews','actor':'11111111-1111-1111-1111-111111111111','revision':'a'*64,'enabled':False,'schedule':None}
    def tearDown(self): self.temp.cleanup()
    def request_socket(self,allowed_uid):
        path=str(self.root/'controller.sock')
        server=socketserver.UnixStreamServer(path,b.Handler)
        with patch.object(b,'read_policy',return_value=({'webUid':allowed_uid},[])),patch.object(b,'handle',return_value={'verified':True}),patch.object(b,'STATE',self.root):
            thread=threading.Thread(target=server.handle_request);thread.start()
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
                client.connect(path);client.sendall(b'POST /v1/runners HTTP/1.0\r\nContent-Length: 15\r\n\r\n{"op":"status"}')
                response=b''
                while True:
                    chunk=client.recv(4096)
                    if not chunk:break
                    response+=chunk
            thread.join(timeout=5)
        server.server_close();return response
    def test_actual_unix_peer_uid_is_required(self):
        response=self.request_socket(os.getuid()+1)
        self.assertIn(b'409',response.split(b'\r\n')[0]);self.assertNotIn(b'"verified": true',response)
    def test_actual_unix_peer_uid_can_read_status(self):
        response=self.request_socket(os.getuid())
        self.assertIn(b'200',response.split(b'\r\n')[0]);self.assertIn(b'"verified": true',response)
    def test_displays_effective_calendar_and_completion_interval(self):
        self.assertEqual(b.displayed_schedule({'TimersCalendar':'{ OnCalendar=*-*-01 02:00:00 Asia/Kuala_Lumpur ; next_elapse=example }'}),'*-*-01 02:00:00 Asia/Kuala_Lumpur')
        self.assertEqual(b.displayed_schedule({'TimersMonotonic':'{ OnUnitInactiveUSec=5min ; next_elapse=example }'}),'5min after completion')
        self.assertIsNone(b.displayed_schedule({}))
    def test_combined_provisioning_entrypoint_cannot_bypass_holiday_hold(self):
        row=next(row for row in CATALOG if row['id']=='provision')
        with patch.object(b,'command',return_value='ExecStart={ argv[]=/opt/node22/bin/node --import tsx scripts/provision-runner.ts ; }'):
            with self.assertRaises(b.Refused):b.separate_capability(row)
        with patch.object(b,'command',return_value='ExecStart={ argv[]=/opt/node22/bin/node --import tsx scripts/provision-only-runner.ts ; }'):
            b.separate_capability(row)
    def test_interval_revision_is_stable_across_runtime_updates_but_changes_with_configuration(self):
        row=next(row for row in CATALOG if row['id']=='notifications')
        service={'LoadState':'loaded','Result':'success','ActiveState':'inactive','ExecMainExitTimestamp':'Sun 2026-11-01 03:00:00 +08','ExecMainExitTimestampMonotonic':'1000000'}
        timer={'LoadState':'loaded','UnitFileState':'enabled','ActiveState':'active','TimersMonotonic':'{ OnUnitInactiveUSec=5min ; next_elapse=100000000 }','NextElapseUSecMonotonic':'100000000'}
        def props(unit):return service if unit.endswith('.service') else timer
        with patch.object(b,'properties',side_effect=props),patch.object(b.time,'monotonic',side_effect=[10,10,20,20]):
            first=b.row_status(self.policy,row);second=b.row_status(self.policy,row)
        self.assertNotEqual(first['nextRun'],second['nextRun'])
        self.assertEqual(first['revision'],second['revision'])
        timer['TimersMonotonic']='{ OnUnitInactiveUSec=10min ; next_elapse=100000000 }'
        with patch.object(b,'properties',side_effect=props):third=b.row_status(self.policy,row)
        self.assertNotEqual(first['revision'],third['revision'])
    def test_native_systemd_unset_and_formatted_monotonic_values(self):
        self.assertEqual(b.monotonic_seconds('infinity'),0)
        self.assertEqual(b.monotonic_seconds('1min 2.5s'),62.5)
        self.assertEqual(b.monotonic_seconds('62500000'),62.5)
        self.assertIsNone(b.next_run({'NextElapseUSecRealtime':'n/a','NextElapseUSecMonotonic':'infinity'}))
    def test_repeated_native_timer_fields_retain_every_schedule(self):
        output='TimersMonotonic={ OnUnitInactiveUSec=2min ; next_elapse=0 }\nTimersMonotonic={ OnBootUSec=1s ; next_elapse=0 }\nLoadState=loaded\n'
        with patch.object(b,'command',return_value=output):values=b.properties('aihr-ai-alerts.timer')
        self.assertIn('OnUnitInactiveUSec=2min',values['TimersMonotonic'])
        self.assertIn('OnBootUSec=1s',values['TimersMonotonic'])
        self.assertEqual(b.displayed_schedule(values),'2min after completion')
    def test_recent_payroll_dispatch_projects_only_the_trusted_journal_timestamp(self):
        when=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)-datetime.timedelta(minutes=10)
        stamp=str(int(when.timestamp())*1000000)
        raw=json.dumps({'__REALTIME_TIMESTAMP':stamp,'MESSAGE':'Private cron command from fixture'})
        with patch.object(b.subprocess,'run',return_value=subprocess.CompletedProcess([],0,raw,'')) as run:
            self.assertEqual(b.legacy_worker_dispatch('payroll-loops'),when.isoformat().replace('+00:00','Z'))
            args=run.call_args.args[0]
            self.assertEqual(args[0],'/usr/bin/journalctl')
            for option in ['--output-fields=__REALTIME_TIMESTAMP','--since=-2h','--lines=1','_UID=0','_EXE=/usr/sbin/cron','_SYSTEMD_UNIT=cron.service']:
                self.assertIn(option,args)
            self.assertEqual(run.call_args.kwargs['timeout'],2)
    def test_legacy_dispatch_absence_or_failure_never_changes_native_state(self):
        for raw in ['', '{"__REALTIME_TIMESTAMP":[]}', '{"__REALTIME_TIMESTAMP":"1000000000000000"}', '{"__REALTIME_TIMESTAMP":"9000000000000000"}']:
            with patch.object(b.subprocess,'run',return_value=subprocess.CompletedProcess([],0,raw,'')):
                self.assertIsNone(b.legacy_worker_dispatch('payroll-loops'))
        with patch.object(b.subprocess,'run',side_effect=subprocess.TimeoutExpired('journalctl',2)):
            self.assertIsNone(b.legacy_worker_dispatch('payroll-loops'))
        with patch.object(b,'row_status',side_effect=lambda _policy,row:{'id':row['id'],'installed':False,'lastRun':None}),patch.object(b,'legacy_worker_dispatch',return_value='2026-11-21T15:45:00Z') as evidence:
            old=b.handle({'op':'status'},self.policy,CATALOG)['runners']
            self.assertFalse(any('legacyCronDispatchedAt' in row for row in old))
            evidence.assert_not_called()
            rows=b.handle({'op':'status_with_cron'},self.policy,CATALOG)['runners']
            evidence.assert_called_once_with('payroll-loops')
            self.assertEqual([row for row in rows if 'legacyCronDispatchedAt' in row],[{'id':'payroll-loops','installed':False,'lastRun':None,'legacyCronDispatchedAt':'2026-11-21T15:45:00Z'}])
    def test_daily_review_dispatch_does_not_expire_in_two_hours(self):
        now=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        for hours in (23,49):
            when=now-datetime.timedelta(hours=hours)
            raw=json.dumps({'__REALTIME_TIMESTAMP':str(int(when.timestamp())*1000000)})
            with patch.object(b.subprocess,'run',return_value=subprocess.CompletedProcess([],0,raw,'')) as run:
                expected=when.isoformat().replace('+00:00','Z') if hours==23 else None
                self.assertEqual(b.legacy_worker_dispatch('reviews'),expected)
                self.assertIn('--since=-48h',run.call_args.args[0])
                self.assertIsNone(b.legacy_worker_dispatch('ai-alerts'))
    def test_legacy_worker_patterns_match_wrappers_and_refuse_lookalikes(self):
        prefix='(fixture) CMD (cd /opt/ai-hr && '
        command=lambda job: 'deploy/cron-alert.sh '+job+' /private/fixture.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/'+job+'.ts)'
        alerts=prefix+command('ai-alerts')
        payroll=prefix+'/usr/bin/flock -n /private/fixture.lock '+command('payroll-loop-tick')
        reviews=prefix+command('review-sweep')
        for key,genuine,other in [('payroll-loops',payroll,reviews),('ai-alerts',alerts,reviews),('reviews',reviews,alerts)]:
            pattern=b.legacy_worker_cron_pattern(key)
            self.assertRegex(genuine,pattern)
            self.assertNotRegex(other,pattern)
            self.assertNotRegex(genuine.replace('&& ','&& echo ',1),pattern)
            self.assertNotRegex(genuine.replace('.ts)', '.ts; false)',1),pattern)
        with patch.object(b,'row_status',side_effect=lambda _policy,row:{'id':row['id'],'installed':False,'lastRun':None}),patch.object(b,'legacy_worker_dispatch',return_value='2026-11-21T15:45:00Z') as evidence:
            rows=b.handle({'op':'status_with_worker_cron'},self.policy,CATALOG)['runners']
            self.assertEqual({call.args[0] for call in evidence.call_args_list},{'payroll-loops','ai-alerts'})
            self.assertEqual({row['id'] for row in rows if 'legacyCronDispatchedAt' in row},{'payroll-loops','ai-alerts'})
            evidence.reset_mock()
            rows=b.handle({'op':'status_with_review_cron'},self.policy,CATALOG)['runners']
            self.assertEqual({call.args[0] for call in evidence.call_args_list},{'payroll-loops','ai-alerts','reviews'})
            self.assertEqual({row['id'] for row in rows if 'legacyCronDispatchedAt' in row},{'payroll-loops','ai-alerts','reviews'})
            self.assertTrue(all(row['lastRun'] is None and not row['installed'] for row in rows))
    def test_installed_interval_drives_overdue_status(self):
        retention=next(row for row in CATALOG if row['id']=='ai-retention')
        service={'LoadState':'loaded','Result':'success','ActiveState':'inactive',
                 'ExecMainExitTimestamp':'Sun 2026-11-01 03:00:00 +08','ExecMainExitTimestampMonotonic':'1000000'}
        timer={'LoadState':'loaded','UnitFileState':'enabled','ActiveState':'active',
               'TimersMonotonic':'{ OnUnitInactiveUSec=5min ; next_elapse=0 }',
               'AccuracyUSec':'15s','RandomizedDelayUSec':'15s'}
        def props(unit):return service if unit.endswith('.service') else timer
        with patch.object(b,'properties',side_effect=props),patch.object(b.time,'monotonic',return_value=631):
            self.assertEqual(b.row_status(self.policy,retention)['health'],'success')
        with patch.object(b,'properties',side_effect=props),patch.object(b.time,'monotonic',return_value=632):
            self.assertEqual(b.row_status(self.policy,retention)['health'],'stale')
            service['ActiveState']='activating'
            self.assertEqual(b.row_status(self.policy,retention)['health'],'running')
            service.update(ActiveState='inactive',Result='exit-code')
            self.assertEqual(b.row_status(self.policy,retention)['health'],'failed')
        self.assertEqual(b.freshness_seconds('interval',{'TimersCalendar':'{ OnCalendar=hourly ; next_elapse=0 }'}),48*3600)
    def test_production_holds_override_commissioned_policy(self):
        policy={**self.policy,'environment':'production'}
        for key in ['replacement-holidays','backups']:
            self.assertTrue(b.held(policy,key))
            request={**self.request,'id':key}
            with patch.object(b,'row_status',return_value={**self.current,'hold':True}),patch.object(b,'command') as command:
                with self.assertRaises(b.Refused):b.handle(request,policy,CATALOG)
                command.assert_not_called()
    def test_schedule_preserves_business_dates_and_explicit_timezone(self):
        for key,wanted in [('accrual','*-*-01'),('carry-expiry','*-04-01')]:
            row=next(row for row in CATALOG if row['id']==key)
            text=b.schedule(row,{'time':'03:15'})
            self.assertIn(wanted+' 03:15:00 Asia/Kuala_Lumpur',text)
            self.assertIn('Persistent=false',text)
    def test_refuses_schedule_and_command_injection(self):
        for value in [{'time':'03:00\nUser=root'},{'minutes':True},{'minutes':0},{'minutes':1441},{'command':'touch /tmp/x'}]:
            for row in [CATALOG[0],CATALOG[1]]:
                with self.assertRaises(b.Refused): b.schedule(row,value)
    def test_refuses_unknown_fields_and_jobs(self):
        for request in [{**self.request,'unit':'attacker.service'},{**self.request,'id':'../../x'},{**self.request,'enabled':'true'},{**self.request,'actor':'not-a-user'}]:
            with patch.object(b,'command') as command:
                with self.assertRaises(ValueError):b.handle(request,self.policy,CATALOG)
                command.assert_not_called()
    def test_stale_form_or_uncommissioned_job_cannot_mutate(self):
        for current in [{**self.current,'revision':'b'*64},{**self.current,'managed':False},{**self.current,'installed':False}]:
            with patch.object(b,'row_status',return_value=current),patch.object(b,'command') as command:
                with self.assertRaises(b.Refused):b.handle(self.request,self.policy,CATALOG)
                command.assert_not_called()
    def test_disable_timer_does_not_stop_inflight_hr_service(self):
        with patch.object(b,'row_status',return_value=self.current),patch.object(b,'STATE',self.root),patch.object(b,'command') as command:
            b.handle(self.request,self.policy,CATALOG)
            self.assertEqual([call.args for call in command.call_args_list],[('disable','aihr-review-sweep.timer'),('stop','aihr-review-sweep.timer')])
            audit=[json.loads(line) for line in (self.root/'audit.jsonl').read_text().splitlines()]
            self.assertEqual([row['outcome'] for row in audit],['requested','applied'])
            self.assertEqual(audit[0]['actor'],self.request['actor'])
    def test_failed_change_is_audited_without_a_false_applied_receipt(self):
        with patch.object(b,'row_status',return_value=self.current),patch.object(b,'STATE',self.root),patch.object(b,'command',side_effect=RuntimeError('private detail')):
            with self.assertRaises(b.Refused):b.handle(self.request,self.policy,CATALOG)
            audit=[json.loads(line) for line in (self.root/'audit.jsonl').read_text().splitlines()]
            self.assertEqual([row['outcome'] for row in audit],['requested','failed'])
            self.assertNotIn('private detail',(self.root/'audit.jsonl').read_text())
unittest.main()
