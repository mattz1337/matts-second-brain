"""HTTP adapter contract tests. All fixtures are synthetic; stdlib only."""
import importlib.util
import json
import sys
import threading
import types
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

# The independent Garmin application's calculations have their own tests. These
# stand-ins exercise only Orbit's HTTP/auth/filtering adapter without installing
# Garmin, calling InfluxDB, reading health files, or sending inference requests.
data = types.ModuleType('app.chat.data')
data.DataTools = object
def validate(plan):
    if not isinstance(plan, dict) or set(plan) != {'source','sport','start','end','metric','group_by'}:
        raise ValueError('Invalid plan')
    return plan
data.validate_plan = validate
data.basic_plan = lambda _question: dict(source='activities',sport='running',start='2026-09-01',end='2026-09-30',metric='sessions',group_by='week')
sys.modules['app'] = types.ModuleType('app')
sys.modules['app.chat'] = types.ModuleType('app.chat')
sys.modules['app.chat.data'] = data
spec=importlib.util.spec_from_file_location('orbit_bridge',Path(__file__).parents[1]/'garmin_bridge.py')
bridge=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Tools:
    def __init__(self):
        self.store=types.SimpleNamespace(status=lambda:{'last_success_utc':'2026-10-01T00:00:00Z','private':'not returned'})
        self.calls=[]
    def run(self,plan,_question):
        self.calls.append(plan)
        return dict(facts={'sessions':4},chart={'title':'Sessions','unit':'sessions','points':[{'date':'2026-09-01','value':4}]},sources=[{'label':'Fixture','detail':'Local calculation'}],last_sync=None,plan=plan,answer='PRIVATE RAW GRAPH TEXT',raw_records=[{'gps':'PRIVATE'}])

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tools=Tools();self.token='a'*64
        self.server=ThreadingHTTPServer(('127.0.0.1',0),bridge.make_handler(self.tools,self.token))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
    def call(self,method,path,body=None,authorized=True,origin=None):
        connection=HTTPConnection(*self.server.server_address,timeout=5)
        headers={'Content-Type':'application/json'}
        if authorized:headers['Authorization']='Bearer '+self.token
        if origin:headers['Origin']=origin
        connection.request(method,path,json.dumps(body) if body is not None else None,headers)
        response=connection.getresponse();status=response.status;raw=response.read();connection.close()
        return status,json.loads(raw)
    def test_authenticated_status_has_no_secrets(self):
        status,body=self.call('GET','/v1/status');self.assertEqual(status,200);self.assertTrue(body['read_only']);self.assertNotIn('private',body)
        self.assertEqual(self.call('GET','/v1/status',authorized=False)[0],401)
    def test_queries_return_only_calculated_fields(self):
        plan=data.basic_plan('fixture')
        status,body=self.call('POST','/v1/query',{'plan':plan})
        self.assertEqual(status,200);self.assertEqual(body['facts']['sessions'],4);self.assertEqual(len(body['snapshot_hash']),64)
        self.assertNotIn('PRIVATE',json.dumps(body));self.assertEqual(len(self.tools.calls),1)
    def test_rejects_browser_origins_and_arbitrary_fields(self):
        self.assertEqual(self.call('POST','/v1/query',{'plan':data.basic_plan('x')},origin='https://malicious.test')[0],401)
        self.assertEqual(self.call('POST','/v1/query',{'sql':'DELETE FROM x'})[0],400)
        self.assertEqual(self.call('POST','/v1/delete',{})[0],404);self.assertEqual(len(self.tools.calls),0)
    def test_basic_questions_still_use_validated_local_tools(self):
        status,body=self.call('POST','/v1/question',{'question':'running last month'})
        self.assertEqual(status,200);self.assertEqual(body['plan']['sport'],'running')
        self.assertEqual(self.call('POST','/v1/question',{'question':'x','extra':True})[0],400)

if __name__=='__main__':unittest.main()
