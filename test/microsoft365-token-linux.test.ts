/** Actual installed unit/UID/socket/proc/cgroup proof on a disposable hosted Linux runner only. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it.skipIf(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')('keeps the installed token capability private and keyless under its real systemd identity and resource limits',()=>{
 const output=execFileSync('sudo',['-n','env','GITHUB_ACTIONS=true','RUNNER_ENVIRONMENT=github-hosted','python3','-I','-B','test/fixtures/microsoft365/token-helper-linux.py',String(process.getuid!())],{cwd:process.cwd(),encoding:'utf8',timeout:45000});
 const result=JSON.parse(output.trim());expect(result).toMatchObject({status:'passed',privatePeerOnly:true,keyAndDatabaseFree:true,actualNamespaceDenial:true,statusWithoutNetwork:true,memoryMaxBytes:33554432,oomKills:0});expect(result.memoryPeakBytes).toBeGreaterThan(0);expect(result.memoryPeakBytes).toBeLessThanOrEqual(result.memoryMaxBytes);
},50000);
