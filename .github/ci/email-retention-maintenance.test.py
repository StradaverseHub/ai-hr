import importlib.util,json,os,pathlib,subprocess,tempfile,unittest,datetime,copy
spec=importlib.util.spec_from_file_location('maintenance',pathlib.Path(__file__).resolve().parents[2]/'deploy/email-retention-maintenance.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MaintenanceRefusalTests(unittest.TestCase):
 def test_private_url_literal_no_shell_execution(self):
  url='postgresql://user:literal$(do-not-run)@localhost/db?sslmode=verify-full'
  self.assertEqual(m.database_url('MIGRATION_DATABASE_URL='+json.dumps(url)),url)
  self.assertIn('password=literal$(do-not-run)',m.service_bytes(url).decode())
 def test_remote_database_and_external_key_loader_parameters_refused(self):
  for url in ['postgres://owner:password@remote.example/db','postgres://owner:password@localhost/db?sslkey=engine:untrusted','postgres://owner:password@localhost/db?sslrootcert=/opt/ai-hr/cert']:
   with self.subTest(url=url),self.assertRaises(m.Refused):m.service_bytes(url)
 def test_duplicate_or_malformed_private_configuration_refused(self):
  for text in ['', 'MIGRATION_DATABASE_URL=http://example.test', 'MIGRATION_DATABASE_URL="unterminated', 'MIGRATION_DATABASE_URL=postgres://a\nMIGRATION_DATABASE_URL=postgres://b', 'MIGRATION_DATABASE_URL="postgres://x\\nsecret"']:
   with self.subTest(text=text),self.assertRaises(m.Refused):m.database_url(text)
 def test_symlink_group_writable_and_multiple_links_refused(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'private';p.write_text('private');p.chmod(0o600)
   self.assertEqual(m.owned_regular(p,uid=os.getuid(),private=True),b'private')
   p.chmod(0o640)
   with self.assertRaises(m.Refused):m.owned_regular(p,uid=os.getuid(),private=True)
   with self.assertRaises(m.Refused):m.owned_regular(p,uid=os.getuid(),state_metadata=True)
   p.chmod(0o600);link=pathlib.Path(directory)/'link';link.symlink_to(p)
   with self.assertRaises(m.Refused):m.owned_regular(link,uid=os.getuid())
   link.unlink();os.link(p,link)
   with self.assertRaises(m.Refused):m.owned_regular(p,uid=os.getuid())
 def test_finite_policy_or_record_changes_do_not_count_as_commissioned(self):
  before={'rows':504,'watermark':'1793109999999','days':None,'revision':0,'deliveries':7,'invitations':4,'lastRun':None,'lastDeleted':0}
  after={**before,'lastRun':'2026-10-27T16:00:00Z'};m.unchanged(before,after)
  for key,value in [('days',30),('revision',1),('deliveries',6),('invitations',3),('lastDeleted',1),('watermark','1793110000000')]:
   with self.subTest(key=key),self.assertRaises(m.Refused):m.unchanged(before,{**after,key:value})
 def test_service_executes_only_system_psql_fixed_sql(self):
  self.assertIn('ExecStart=/usr/lib/postgresql/16/bin/psql -X -qAt -v ON_ERROR_STOP=1 -c "select app.account_email_retention_prune()"',m.SERVICE)
  self.assertNotIn('/opt/ai-hr',m.SERVICE);self.assertNotIn('node',m.SERVICE);self.assertNotIn('bash',m.SERVICE)
  self.assertIn('User=aihr-maintenance',m.SERVICE);self.assertIn('ProtectSystem=strict',m.SERVICE)
 def test_exclusive_creation_never_overwrites_human_file(self):
  with tempfile.TemporaryDirectory() as directory:
   p=pathlib.Path(directory)/'unit';p.write_bytes(b'human')
   with self.assertRaises(FileExistsError):m.exclusive(p,b'replacement')
   self.assertEqual(p.read_bytes(),b'human')
 def test_nonroot_entry_refuses_before_any_mutation(self):
  if os.geteuid()==0:self.skipTest('Hosted controls run unprivileged')
  result=subprocess.run(['python3',str(pathlib.Path(m.__file__)),'install'],capture_output=True,text=True)
  self.assertEqual(result.returncode,1);self.assertTrue(json.loads(result.stdout)['maintenanceRefused'])
 def test_private_service_file_connects_without_secret_in_argv_or_environment(self):
  url=os.environ.get('RETENTION_TEST_DATABASE_URL')
  if not url:self.skipTest('Hosted disposable PostgreSQL fixture only')
  with tempfile.TemporaryDirectory() as directory:
   config=pathlib.Path(directory)/'pg_service.conf';m.exclusive(config,m.service_bytes(url))
   env={'PATH':'/usr/bin:/bin','PGSERVICEFILE':str(config),'PGSERVICE':'aihr_email_retention'}
   self.assertEqual(m.run([m.PSQL,'-X','-qAt','-v','ON_ERROR_STOP=1','-c','select 1'],env),'1')
class JournalCompletionTests(unittest.TestCase):
 def fixture(self):
  base={'_UID':'0','UNIT':m.NAME+'.service','INVOCATION_ID':'bounded-invocation'}
  start={**base,'MESSAGE_ID':'7d4958e842da4a758f6c1cdc7b36dcc5','__REALTIME_TIMESTAMP':'1793118846348676'}
  sql={'_UID':'994','_SYSTEMD_UNIT':m.NAME+'.service','_EXE':m.PSQL,'_SYSTEMD_INVOCATION_ID':'bounded-invocation','MESSAGE':'0','__REALTIME_TIMESTAMP':'1793118846565876'}
  end={**base,'MESSAGE_ID':'39f53479d3a045ac8e11786248231fbf','JOB_RESULT':'done','__REALTIME_TIMESTAMP':'1793118846584395'}
  return [start,sql,end]
 def validate(self,rows,last='2026-10-27T16:34:06.548Z',now=None):
  return m.journal_success(rows,994,last,now or datetime.datetime(2026,10,27,16,35,tzinfo=datetime.timezone.utc))
 def test_actual_completed_oneshot_accepted_without_transient_execmain_fields(self):
  self.assertEqual(self.validate(self.fixture()),'bounded-invocation')
 def test_foreign_uid_executable_invocation_failure_nonzero_or_stale_refused(self):
  for index,key,value in [(1,'_UID','0'),(1,'_EXE','/opt/ai-hr/mutable'),(1,'MESSAGE','1'),(1,'_SYSTEMD_INVOCATION_ID','foreign'),(2,'_UID','994'),(2,'JOB_RESULT','failed'),(0,'INVOCATION_ID','foreign')]:
   rows=copy.deepcopy(self.fixture());rows[index][key]=value
   with self.subTest(key=key,value=value),self.assertRaises(m.Refused):self.validate(rows)
  with self.assertRaises(m.Refused):self.validate(self.fixture(),now=datetime.datetime(2026,10,29,tzinfo=datetime.timezone.utc))
  with self.assertRaises(m.Refused):self.validate(self.fixture(),last='2026-10-27T16:30:00Z')
 def test_default_success_without_actual_journal_is_refused(self):
  for rows in [[],self.fixture()[1:],self.fixture()[:2],self.fixture()+[self.fixture()[1]]]:
   with self.assertRaises(m.Refused):self.validate(rows)
if __name__=='__main__':unittest.main()
