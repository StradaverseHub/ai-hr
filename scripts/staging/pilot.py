#!/usr/bin/env python3
"""Isolated two-member scheduling pilot. Does not deploy or create release acceptance."""
import json
from pathlib import Path
import tempfile
import uuid
import sys
sys.dont_write_bytecode = True
from coordinator import Coordinator, PROTOCOL


def pilot():
    source='b'*40; baseline='a'*40
    state=dict(state='ok',stale_build='0',ref=baseline,built_ref=baseline,build_id='old',built_build_id='old')
    with tempfile.TemporaryDirectory(prefix='aihr-batch-pilot-') as directory:
        root=Path(directory);root.chmod(0o700)
        codex=Coordinator(root,lambda:dict(state));claude=Coordinator(root,lambda:dict(state))
        def request(c,actor,action,**fields):return c.request(dict(protocol=PROTOCOL,actor=actor,action=action,**fields))
        ids=[]
        for actor,c,member in [('codex:pilot',codex,'c'*40),('claude:pilot',claude,'d'*40)]:
            key=str(uuid.uuid4());ids.append(key)
            request(c,actor,'submit',spec=dict(id=key,source=member,base=baseline,dependencies=[],risk='ordinary',migrations=[],acceptance='Fixture-only changed journey',evidence='Fixture-only: no release witness'))
        batch=request(codex,'controller:pilot','prepare',tickets=ids,candidate=source,baseline=baseline,baselineBuild='old')['batch']
        g=request(codex,'controller:pilot','claim',batch=batch)
        grant={k:g[k] for k in ('batch','epoch','token','candidate')}
        refused=False
        try:request(claude,'claude:pilot','claim',batch=batch)
        except ValueError:refused=True
        assert refused
        request(codex,'controller:pilot','phase',**grant,phase='installing')
        state.update(ref=source,built_ref=source,build_id='fixture-new',built_build_id='fixture-new')
        request(codex,'controller:pilot','phase',**grant,phase='arrived',build='fixture-new')
        request(codex,'controller:pilot','phase',**grant,phase='accepting',build='fixture-new')
        request(codex,'controller:pilot','finish',**grant,reason='Fixture acceptance and handback only; no application deployment')
        status=request(claude,'claude:pilot','status')
        assert status['lease']['batch'] is None and all(t['state']=='complete' for t in status['tickets'])
        result=dict(kind='ISOLATED_TWO_SESSION_BATCH_PILOT',members=2,controllers=1,competingClaimRefused=refused,handbackVerified=True,releaseAuthorized=False,applicationDeployed=False,events=len(status['events']))
        codex.db.close();claude.db.close()
        return result


if __name__=='__main__':print(json.dumps(pilot(),sort_keys=True))
