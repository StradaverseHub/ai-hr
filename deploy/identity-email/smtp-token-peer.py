#!/usr/bin/python3
"""One bounded Microsoft token request. No database, Auth key, SMTP, files or caller endpoint."""
import json
import os
import re
import signal
import socket
import ssl
import struct
import sys
import time
import urllib.parse
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect refused')

def acquire(request, opener=None, clock=time.time):
    assert type(request) is dict and set(request)=={'tenantId','clientId','clientSecret'}
    for key in ['tenantId','clientId']:
        assert type(request[key]) is str and re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}',request[key])
    assert type(request['clientSecret']) is str and 0<len(request['clientSecret'])<=4096
    context=ssl.create_default_context();context.minimum_version=ssl.TLSVersion.TLSv1_2
    # Ignore proxy environment; only the fixed public HTTPS endpoint is a capability.
    opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPSHandler(context=context))
    started=clock()
    data=urllib.parse.urlencode({'client_id':request['clientId'],'client_secret':request['clientSecret'],'grant_type':'client_credentials','scope':'https://outlook.office365.com/.default'}).encode()
    req=urllib.request.Request('https://login.microsoftonline.com/'+request['tenantId']+'/oauth2/v2.0/token',data=data,headers={'Content-Type':'application/x-www-form-urlencoded'},method='POST')
    with opener.open(req,timeout=8) as response:
        assert response.status==200
        raw=response.read(32769);assert len(raw)<=32768
    token=json.loads(raw)
    assert type(token) is dict and type(token.get('token_type')) is str and token['token_type'].lower()=='bearer'
    value=token.get('access_token');assert type(value) is str and re.fullmatch(r'[\x21-\x7e]{1,16384}',value)
    lifetime=token.get('expires_in');assert type(lifetime) is int and 120<=lifetime<=86400
    expires=int((started+lifetime)*1000);assert expires>int(clock()*1000)+60000
    return {'accessToken':value,'accessTokenExpiresAt':expires}

def main():
    assert sys.platform=='linux' and os.getuid()>0
    expected=os.environ.get('SMTP_TOKEN_PEER_UID','');assert re.fullmatch(r'[1-9][0-9]{0,9}',expected)
    assert not any(os.environ.get(key) for key in ['DATABASE_URL','MIGRATION_DATABASE_URL','AUTH_SESSION_KEY','IDENTITY_EMAIL_DATABASE_URL'])
    signal.alarm(12)
    with socket.socket(fileno=0) as peer:
        peer.settimeout(8)
        _,uid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        assert uid==int(expected) and uid!=os.getuid()
        body=bytearray()
        while True:
            chunk=peer.recv(min(4096,32769-len(body)))
            if not chunk:break
            body.extend(chunk);assert len(body)<=32768
        request=json.loads(body)
        result={'available':True} if request=={'op':'status'} else acquire(request)
        peer.sendall(json.dumps(result,separators=(',',':')).encode())

if __name__=='__main__':
    try:main()
    except Exception:
        # No provider body, error details, credential, request or partial reply reaches logs.
        raise SystemExit(1)
