"""Current SDK status/receive and patched continuous loop; no network calls.

The SDK's real query/receive/first-frame selection and decoded-response consumers execute.
Frames and decoded JSON are controlled at the existing validated-frame boundary;
this does not simulate encryption or prove a household packet's cause.
"""
import ast, asyncio, hashlib, importlib.util, json, logging, pathlib, socket, sys, threading, time, unittest
from collections import deque
from contextlib import contextmanager
from copy import deepcopy
from types import SimpleNamespace
sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('observations', ROOT/'test/helpers/tuya-local-observation.py')
o = importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
SOURCE = ROOT/'test/fixtures/tinytuya-1.20.0/XenonDevice.py'
CT = SimpleNamespace(DP_QUERY=10, DP_QUERY_NEW=16, STATUS=8, CONTROL=7, HEART_BEAT=9, UPDATEDPS=18)
CONSTANTS = SimpleNamespace(**vars(CT), PREFIX_55AA_VALUE=0x55AA)
class MessagePayload:
    def __init__(self, cmd):self.cmd = cmd
SDK = o.extracted_class(SOURCE.read_bytes(), 'XenonDevice', {
    'status', 'receive', '_send_receive', '_process_message', '_get_retcode', '_get_socket'
}, {'CT':CT, 'MessagePayload':MessagePayload, 'parse_header':lambda p:p,
    'log':logging.getLogger('synthetic-sdk'), 'socket':socket, 'time':time,
    'DecodeError':type('DecodeError',(Exception,),{}),
    'error_json':lambda code:{'Err':str(code),'Error':'Synthetic native failure'},
    'ERR_DEVTYPE':902,'ERR_PAYLOAD':904,'ERR_CONNECT':905,'ERR_TIMEOUT':902,'ERR_OFFLINE':901,'ERR_KEY_OR_VER':914})
Device = o.extracted_class(o.PATCHED['device.py'], 'TuyaLocalDevice', {
    '_observe_local_dps', '_clear_local_observations', '_diagnose_local_withdrawal', '_reset_cached_state', 'local_observations',
    'get_property', '_get_cached_state', '_get_pending_properties', '_get_pending_updates',
    '_remove_properties_from_pending_updates', 'receive_loop', 'async_receive', 'should_poll',
    'has_returned_state', 'unique_id', 'name', '_retry_on_failed_connection',
    '_register_local_observation_source', '_local_observation_source_exclusive', '_set_values', '_get_unsent_properties',
    '_status_for_local_observations', '_receive_for_local_observations', '_native_reply_for_local_observations',
    '_local_observation_source_context', '_local_reply_is_current',
    '_local_status_refresh_source', '_request_local_status_refresh', '_take_local_status_refresh',
}, {'asyncio':asyncio, 'CancelledError':asyncio.CancelledError, 'time':lambda:o.CLOCK[0],
    'deepcopy':deepcopy,'sha256':hashlib.sha256,'monotonic':time.monotonic,'_LOGGER':logging.getLogger('synthetic-query'),
    'log_json':lambda value:'<synthetic>','_ERROR_HINTS':{},'_NO_PENDING_UPDATES':object(),
    'tinytuya':CONSTANTS,'DOMAIN':'tuya_local','get_device_id':lambda v:v['device_id']+':'+v['device_cid'],
    'CONF_DEVICE_ID':'device_id','CONF_DEVICE_CID':'device_cid'})
NativeCommands=o.extracted_class((ROOT/'test/fixtures/tinytuya-1.20.0/Device.py').read_bytes(), 'Device', {
    'heartbeat','updatedps','set_value','set_multiple_values'
}, {'CT':CT,'log':logging.getLogger('synthetic-sdk'),'time':time})
for method in ('heartbeat','updatedps','set_value','set_multiple_values'):
    setattr(SDK,method,getattr(NativeCommands,method))
ALL = {'1':True,'2':55,'4':'mid','6':50}
def frame(data, seq, cmd=10, **changes):
    f=SimpleNamespace(payload=json.dumps({'dps':data}).encode(),seqno=seq,cmd=cmd,
        crc_good=True,retcode=0,prefix=0x55AA)
    for k,v in changes.items():setattr(f,k,v)
    return f
class Wire:
    def __init__(self):self.frames=deque();self.sent=[];self.closed=False
    def sendall(self,p):self.sent.append(p)
    def settimeout(self,value):self.timeout=value
    def setsockopt(self,*args):pass
    def connect(self,address):self.connected=address
    def close(self):self.closed=True
    def next(self):
        if not self.frames:raise socket.timeout()
        value=self.frames.popleft()
        if isinstance(value,Exception):raise value
        return value

def fixture(api=None, record=None):
    if api is None:o.CLOCK[0]=1_800_000_000.0
    n=api or SDK.__new__(SDK)
    if api is None:
        n.id='synthetic-native';n.parent=None;n.children={};n.received_wrong_cid_queue=[]
        n.socket=Wire();n.socketPersistent=True;n.auto_ip=False;n.address='127.0.0.1';n.port=6668
        n.local_key=b'0000000000000000';n.socketNODELAY=False;n.connection_timeout=0.05
        n.version=3.3;n.seqno=1;n.raw_sent=None;n.raw_recv=[]
        n.cmd_retcode=None;n.dev_type='default';n.retry=False;n.socketRetryLimit=1;n.sendWait=None
        n._get_socket=lambda _:True;n._check_socket_close=lambda *_:None
        n.set_socketPersistent=lambda value:setattr(n,'socketPersistent',value)
        n.max_simultaneous_dps=0
        n.generate_payload=lambda cmd,*args:MessagePayload(cmd)
        def encode(p):
            header=SimpleNamespace(seqno=n.seqno,cmd=p.cmd,prefix=0x55AA)
            n.seqno+=1;return header
        n._encode_message=encode;n._receive=lambda:n.socket.next()
        n._decode_payload=lambda data:json.loads(data);n._cache_response=lambda _:None;n._process_response=lambda data:data
    d=Device.__new__(Device);d._children=[];d._name='Synthetic appliance';d.dev_cid=None;d.dev_id=n.id;d._api=n
    d._FAKE_IT_TIMEOUT=5;d._CACHE_TIMEOUT=30;d._HEARTBEAT_INTERVAL=5
    d._reset_cached_state();d._running=True;d._poll_only=False;d._temporary_poll=False
    d._last_full_poll=o.CLOCK[0];d._force_dps=[];d._last_connection=o.CLOCK[0]
    d._api_protocol_version_index=0;d._protocol_configured=3.3;d._api_protocol_working=True
    d._api_working_protocol_failures=0;d._AUTO_FAILURE_RESET_COUNT=10;d._SINGLE_PROTO_CONNECTION_ATTEMPTS=3
    d._api_lock=record['tuyadevicelock'] if record else asyncio.Lock()
    record=record or {'tuyadevice':n,'tuyadevicelock':d._api_lock}
    async def executor(fn,*args):return fn(*args)
    d._hass=SimpleNamespace(is_stopping=False,async_add_executor_job=executor,data={'tuya_local':{n.id:record}})
    d._register_local_observation_source(d._hass,d._name)
    if api is None:
        n.socket.frames.append(frame(ALL,n.seqno));r=d._status_for_local_observations()
        d._cached_state.update(r['dps']);d._cached_state['updated_at']=o.CLOCK[0];d._observe_local_dps(r['dps'],d._local_reply_full)
    return n,d

@contextmanager
def first_open(n,wire):
    # Execute the actual pinned SDK socket-opening producer. Only its native
    # socket factory is in-memory; no real connection, discovery or key lookup.
    namespace=SDK._get_socket.__globals__;old=namespace['socket']
    proxy=SimpleNamespace(**{name:getattr(socket,name) for name in ('AF_INET','AF_INET6','SOCK_STREAM','IPPROTO_TCP','TCP_NODELAY','timeout')})
    proxy.socket=lambda *args:wire
    namespace['socket']=proxy;n.socket=None
    n._get_socket=SDK._get_socket.__get__(n,SDK)
    try:yield
    finally:namespace['socket']=old

async def collect(n,d,frames,second_query=False,callback=None):
    n.socket.frames.extend(frames);seen=[]
    def observe(data,full):
        seen.append({'full':full,'observations':d.local_observations,'cachedPower':d.get_property('1')})
        if callback:callback(len(seen),n,d)
        if second_query and len(seen)==1:o.CLOCK[0]+=31
        if len(seen)==len(frames):d._running=False
    d._children=[SimpleNamespace(on_receive=observe,schedule_update_ha_state=lambda:None,
        _config=SimpleNamespace(dps=lambda:[SimpleNamespace(id='1',persist=True)]))]
    await d.receive_loop();return seen

class QueryReplyTests(unittest.TestCase):
    def test_sdk_fixture_is_the_exact_pinned_current_public_source(self):
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'cd3a5f333eed39c55dafd821a01810ac824c74e6cbd330c9b863e43bf4b7963f')
    def sequence(self,kind):
        n,d=fixture();original=d.local_observations['1'];o.CLOCK[0]+=31;a=n.seqno
        frames=[frame({'6':49},999,8),frame({} if kind=='empty' else {'6':48} if kind=='omission' else ALL,a)]
        before=len(n.socket.sent)
        seen=asyncio.run(collect(n,d,frames));self.assertEqual(len(seen),2)
        self.assertEqual(len(n.socket.sent)-before,1,'Classification adds no query or drain')
        self.assertFalse(seen[0]['full']);self.assertEqual(seen[0]['observations']['1'],original)
        self.assertTrue(seen[0]['cachedPower']);self.assertTrue(seen[1]['full'])
        if kind=='complete':self.assertEqual(seen[1]['observations']['1']['timestamp'],int(o.CLOCK[0]*1000))
        else:self.assertNotIn('1',seen[1]['observations'])
    def test_unsolicited_partial_then_delayed_complete(self):self.sequence('complete')
    def test_unsolicited_partial_then_delayed_omission(self):self.sequence('omission')
    def test_unsolicited_partial_then_delayed_empty_dps(self):self.sequence('empty')
    def test_full_query_direct_omission_and_empty_omit_power(self):
        for data in ({'6':49},{}):
            n,d=fixture();o.CLOCK[0]+=31
            seen=asyncio.run(collect(n,d,[frame(data,n.seqno)]))
            self.assertTrue(seen[0]['full']);self.assertNotIn('1',seen[0]['observations'])
    def test_query_b_consumes_delayed_full_query_a_omission(self):
        n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},a),frame(ALL,a+1)],True))
        self.assertFalse(seen[0]['full']);self.assertTrue(seen[1]['full']);self.assertNotIn('1',seen[1]['observations'])
        self.assertTrue(seen[2]['full']);self.assertIn('1',seen[2]['observations'])
    def test_both_query_partials_then_old_complete_and_new_omission_fail_closed(self):
        n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},998,8),frame(ALL,a),frame({'6':47},a+1)],True))
        self.assertFalse(seen[0]['full']);self.assertTrue(all(s['full'] for s in seen[1:]));self.assertIn('1',seen[2]['observations']);self.assertNotIn('1',seen[3]['observations'])
    def test_heartbeat_or_command_header_cannot_replace_pending_query_identity(self):
        n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
        def change(index,n,d):
            if index==1:n.raw_sent=SimpleNamespace(seqno=1000,cmd=7,prefix=0x55AA)
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},a)],callback=change))
        self.assertTrue(seen[1]['full']);self.assertNotIn('1',seen[1]['observations'])
    def test_bad_integrity_retcode_or_header_cannot_exempt_a_status_call(self):
        for changes in ({'crc_good':None},{'retcode':1},{'retcode':None},{'retcode':False},{'seqno':True},{'cmd':True},{'prefix':None}):
            n,d=fixture();o.CLOCK[0]+=31
            invalid=frame({'6':49},999,8)
            for key,value in changes.items():setattr(invalid,key,value)
            seen=asyncio.run(collect(n,d,[invalid]))
            self.assertTrue(seen[0]['full'],changes);self.assertNotIn('1',seen[0]['observations'])
    def test_unknown_metadata_after_partial_is_conservatively_full(self):
        n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},a,crc_good=None)]))
        self.assertTrue(seen[1]['full']);self.assertNotIn('1',seen[1]['observations'])
    def test_shared_api_before_query_declines_incremental_exemption(self):
        n,d=fixture();fixture(n,d._local_source_record);o.CLOCK[0]+=31
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8)]))
        self.assertTrue(seen[0]['full']);self.assertNotIn('1',seen[0]['observations'])
    def test_shared_api_appearing_mid_ticket_keeps_delayed_full_omission(self):
        n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
        def register(index,n,d):
            if index==1:fixture(n,d._local_source_record)
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},a)],callback=register))
        self.assertFalse(seen[0]['full']);self.assertTrue(seen[1]['full']);self.assertNotIn('1',seen[1]['observations'])
    def test_other_protocol_and_gateway_sources_keep_existing_full_status(self):
        for kind in ('3.4','3.5','parent','children','cid'):
            n,d=fixture();o.CLOCK[0]+=31
            if kind[0]=='3':n.version=float(kind)
            elif kind=='parent':n.parent=SimpleNamespace(_send_receive=lambda *_a,**_k:{'dps':{'6':49}},set_socketPersistent=lambda _:None)
            elif kind=='children':n.children={'synthetic-child':SimpleNamespace()}
            else:d.dev_cid='synthetic-child'
            if kind=='parent':
                result=d._status_for_local_observations();d._observe_local_dps(result['dps'],d._local_reply_full);self.assertNotIn('1',d.local_observations)
            else:
                seen=asyncio.run(collect(n,d,[frame({'6':49},999,8)]));self.assertTrue(seen[0]['full']);self.assertNotIn('1',seen[0]['observations'])
    def test_stale_raw_metadata_does_not_authorize_incremental_exemption(self):
        n,d=fixture();n.raw_sent=SimpleNamespace(seqno=2,cmd=10,prefix=0x55AA)
        stale=frame({'6':49},999,8);n.raw_recv=[stale]
        n.status=lambda:{'dps':{'6':49}}
        result=d._status_for_local_observations();d._observe_local_dps(result['dps'],d._local_reply_full)
        self.assertTrue(d._local_reply_full);self.assertNotIn('1',d.local_observations)
    def test_copied_stale_frame_is_not_a_fresh_native_reply(self):
        n,d=fixture();stale=frame({'6':49},999,8);n.raw_recv=[stale]
        def status():
            n.raw_sent=SimpleNamespace(seqno=2,cmd=10,prefix=0x55AA);n.raw_recv=[stale];return {'dps':{'6':49}}
        n.status=status;result=d._status_for_local_observations();d._observe_local_dps(result['dps'],d._local_reply_full)
        self.assertTrue(d._local_reply_full);self.assertNotIn('1',d.local_observations)
    def test_socket_api_version_and_reset_retire_pending_original_ticket(self):
        for kind in ('socket','api','version','reset'):
            n,d=fixture();a=n.seqno;n.socket.frames.append(frame({'6':49},999,8));d._status_for_local_observations();self.assertIsNotNone(d._local_query_ticket)
            if kind=='socket':n.socket=Wire()
            elif kind=='api':n,d2=fixture();d._api=n
            elif kind=='version':n.version=3.5
            else:d._clear_local_observations("cache-reset")
            n.socket.frames.append(frame({'6':48},a));result=d._receive_for_local_observations();d._observe_local_dps(result['dps'],d._local_reply_full)
            self.assertIsNone(d._local_query_ticket);self.assertNotIn('1',d.local_observations)

    def test_sync_status_consumer_preserves_partial_then_withdraws_queued_omission(self):
        n,d=fixture();d._running=False;old=d.local_observations['1'];o.CLOCK[0]+=31;a=n.seqno
        n.socket.frames.extend([frame({'6':49},999,8),frame({'6':48},a)])
        o.Device._refresh_cached_state(d)
        self.assertEqual(d.local_observations['1'],old)
        o.Device._refresh_cached_state(d)
        self.assertNotIn('1',d.local_observations)
        self.assertTrue(d.get_property('1'),'Optimistic HA cache remains separate from observed fields')

    def test_native_error_retires_ticket_and_original_observations(self):
        async def run():
            n,d=fixture();n.socket.frames.append(frame({'6':49},999,8))
            d._status_for_local_observations();self.assertIsNotNone(d._local_query_ticket)
            def offline(_):d._running=False;return 901
            n._get_socket=offline
            generator=d.async_receive()
            with self.assertRaises(StopAsyncIteration):await generator.__anext__()
            self.assertIsNone(d._local_query_ticket)
            self.assertEqual(set(d.local_observations),{'identity'})
        asyncio.run(run())

    def test_actual_nowait_command_and_heartbeat_do_not_consume_delayed_full_reply(self):
        n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
        def send(index,n,d):
            if index==1:
                remaining=len(n.socket.frames)
                d._pending_updates={'1':{'value':False,'updated_at':o.CLOCK[0],'sent':False}}
                self.assertIsNone(d._set_values())
                self.assertIsNone(n.heartbeat(True))
                self.assertEqual(len(n.socket.frames),remaining)
                self.assertTrue(d._pending_updates['1']['sent'])
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},a)],callback=send))
        self.assertTrue(seen[1]['full']);self.assertNotIn('1',seen[1]['observations'])

    def test_forced_dps_source_cannot_gain_incremental_query_exemption(self):
        n,d=fixture();d._force_dps=[6]
        n.socket.frames.append(frame({'6':49},999,8))
        result=d._status_for_local_observations()
        self.assertTrue(d._local_reply_full)
        d._observe_local_dps(result['dps'],d._local_reply_full)
        self.assertNotIn('1',d.local_observations)

    def test_forced_dps_activated_mid_ticket_withdraws_before_consuming_full_omission(self):
        n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
        def activate(index,n,d):
            if index==1:d._force_dps=[6]
        seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},a)],True,activate))
        self.assertFalse(seen[0]['full']);self.assertNotIn('1',seen[1]['observations'])

    def test_current_hass_record_removal_or_replacement_mid_ticket_fails_closed(self):
        for kind in ('remove','replace'):
            n,d=fixture();o.CLOCK[0]+=31;a=n.seqno
            def change(index,n,d):
                if index==1:
                    if kind=='remove':d._hass.data['tuya_local'].pop(n.id)
                    else:d._hass.data['tuya_local'][n.id]={'tuyadevice':n,'tuyadevicelock':d._api_lock}
            seen=asyncio.run(collect(n,d,[frame({'6':49},999,8),frame({'6':48},a)],callback=change))
            self.assertTrue(seen[1]['full']);self.assertNotIn('1',seen[1]['observations'])

    def test_real_factory_twice_cannot_mint_two_exclusive_readers(self):
        n,_=fixture();n.set_socketRetryLimit=lambda count:setattr(n,'socketRetryLimit',count)
        constants={name:name for name in ('CONF_NAME','CONF_DEVICE_ID','CONF_HOST','CONF_LOCAL_KEY','CONF_PROTOCOL_VERSION','CONF_DEVICE_CID','CONF_POLL_ONLY','CONF_MANUFACTURER','CONF_MODEL')}
        namespace={'asyncio':asyncio,'time':lambda:o.CLOCK[0],'deepcopy':deepcopy,'sha256':hashlib.sha256,
            '_LOGGER':logging.getLogger('synthetic-factory'),'log_json':lambda v:'<synthetic>',
            'tinytuya':SimpleNamespace(Device=lambda *args,**kwargs:n,**vars(CONSTANTS)),
            'DOMAIN':'tuya_local','HomeAssistant':object,'API_PROTOCOL_VERSIONS':[3.3],**constants}
        FactoryDevice=o.extracted_class(o.PATCHED['device.py'],'TuyaLocalDevice', {
            '__init__','_register_local_observation_source','_local_observation_source_exclusive',
            '_reset_cached_state','_clear_local_observations'
        },namespace)
        import re
        text=re.sub(r'except ([\w.]+(?:, [\w.]+)+):',r'except (\1):',o.PATCHED['device.py'].decode())
        tree=ast.parse(text)
        function=next(row for row in tree.body if isinstance(row,ast.FunctionDef) and row.name=='setup_device')
        namespace.update(TuyaLocalDevice=FactoryDevice,get_device_id=lambda c:c['CONF_DEVICE_ID'])
        exec(compile(ast.Module(body=[function],type_ignores=[]),'<pinned-current-factory>','exec'),namespace)
        hass=SimpleNamespace(data={'tuya_local':{}})
        config={'CONF_NAME':'Synthetic appliance','CONF_DEVICE_ID':n.id,'CONF_HOST':'127.0.0.1','CONF_LOCAL_KEY':'synthetic','CONF_PROTOCOL_VERSION':3.3,'CONF_POLL_ONLY':False}
        first=namespace['setup_device'](hass,config)
        self.assertTrue(first._local_observation_source_exclusive())
        second=namespace['setup_device'](hass,config)
        self.assertIs(first._api,second._api);self.assertIs(first._api_lock,second._api_lock)
        self.assertFalse(first._local_observation_source_exclusive());self.assertFalse(second._local_observation_source_exclusive())
        self.assertIsNone(hass.data['tuya_local'][n.id]['stmq_observation_reader'])

    def test_executor_reply_revoked_before_consumer_cannot_republish_complete_fields(self):
        async def run():
            n,d=fixture();o.CLOCK[0]+=31;n.socket.frames.append(frame(ALL,n.seqno))
            received=[]
            d._children=[SimpleNamespace(on_receive=lambda *args:received.append(args),schedule_update_ha_state=lambda:None)]
            async def executor(fn,*args):
                result=fn(*args)
                d._clear_local_observations("cache-reset");d._running=False
                return result
            d._hass.async_add_executor_job=executor
            await d.receive_loop()
            self.assertEqual(received,[])
            self.assertEqual(set(d.local_observations),{'identity'})
        asyncio.run(run())

    def test_executor_api_or_selected_record_movement_revokes_before_publication(self):
        for kind in ('api','socket','version','source'):
            async def run():
                n,d=fixture();replacement,_=fixture();o.CLOCK[0]+=31
                n.socket.frames.append(frame(ALL,n.seqno));received=[]
                d._children=[SimpleNamespace(on_receive=lambda *args:received.append(args),schedule_update_ha_state=lambda:None)]
                async def executor(fn,*args):
                    result=fn(*args)
                    if kind=='api':d._api=replacement
                    elif kind=='socket':n.socket=Wire()
                    elif kind=='version':n.version=3.5
                    else:d._hass.data['tuya_local'].pop(n.id)
                    d._running=False
                    return result
                d._hass.async_add_executor_job=executor
                await d.receive_loop()
                self.assertEqual(received,[])
                self.assertEqual(set(d.local_observations),{'identity'})
            asyncio.run(run())

    def test_reader_becomes_shared_before_partial_admission_withdraws_held_fields(self):
        n,d=fixture();n.socket.frames.append(frame({'6':49},999,8))
        result=d._status_for_local_observations();self.assertFalse(d._local_reply_full)
        fixture(n,d._local_source_record)
        self.assertFalse(d._local_reply_is_current(result))
        self.assertEqual(set(d.local_observations),{'identity'})
        self.assertIsNone(d._local_query_ticket)

    def test_current_generation_invalidated_inside_native_status_cannot_repopulate(self):
        n,d=fixture()
        def status():
            d._clear_local_observations("cache-reset")
            return {'dps':ALL}
        n.status=status
        self.assertIsNone(d._status_for_local_observations())
        self.assertEqual(set(d.local_observations),{'identity'})

    def test_old_api_reply_is_discarded_after_source_replacement(self):
        n,d=fixture();replacement,_=fixture()
        def status():
            d._api=replacement
            return {'dps':ALL}
        n.status=status
        self.assertIsNone(d._status_for_local_observations())
        self.assertEqual(set(d.local_observations),{'identity'})

    def test_current_full_sync_poll_discards_generation_revoked_reply(self):
        # Execute the actual synchronous consumer, not just its classifier.
        n,d=fixture();d._running=False
        Sync=o.Device
        def status():
            d._clear_local_observations("cache-reset")
            return {'dps':ALL}
        n.status=status;old_cache=deepcopy(d._cached_state)
        Sync._refresh_cached_state(d)
        self.assertEqual(d._cached_state,old_cache)
        self.assertEqual(set(d.local_observations),{'identity'})

    def test_pending_receive_uses_existing_lock_until_native_socket_timeout(self):
        async def run():
            n,d=fixture();n.socket.frames.append(frame({'6':49},999,8))
            d._status_for_local_observations();self.assertIsNotNone(d._local_query_ticket)
            original=d.local_observations;entered=threading.Event();order=[]
            def receive():
                entered.set();time.sleep(0.05);order.append('native-timeout')
                d._running=False;raise socket.timeout()
            n._receive=receive
            async def executor(fn,*args):return await asyncio.to_thread(fn,*args)
            d._hass.async_add_executor_job=executor
            generator=d.async_receive();reader=asyncio.create_task(generator.__anext__())
            self.assertTrue(await asyncio.to_thread(entered.wait,1));self.assertTrue(d._api_lock.locked())
            async def command():
                async with d._api_lock:order.append('command')
            sender=asyncio.create_task(command());await asyncio.sleep(0)
            self.assertFalse(sender.done())
            await asyncio.wait_for(sender,1)
            with self.assertRaises(StopAsyncIteration):await asyncio.wait_for(reader,1)
            self.assertEqual(order,['native-timeout','command'])
            self.assertEqual(set(d.local_observations),{'identity'})
            self.assertFalse(d._api_lock.locked())
        asyncio.run(run())

    def test_cancellation_releases_lock_and_late_executor_cannot_restore_evidence(self):
        async def run():
            n,d=fixture();a=n.seqno;n.socket.frames.append(frame({'6':49},999,8))
            d._status_for_local_observations()
            entered=threading.Event();release=threading.Event();finished=threading.Event()
            def receive():
                entered.set();release.wait(1)
                return frame(ALL,a)
            n._receive=receive
            async def executor(fn,*args):
                def body():
                    try:return fn(*args)
                    finally:finished.set()
                return await asyncio.to_thread(body)
            d._hass.async_add_executor_job=executor
            generator=d.async_receive();reader=asyncio.create_task(generator.__anext__())
            self.assertTrue(await asyncio.to_thread(entered.wait,1));self.assertTrue(d._api_lock.locked())
            reader.cancel()
            with self.assertRaises(asyncio.CancelledError):await reader
            self.assertFalse(d._api_lock.locked());self.assertIsNone(d._local_query_ticket)
            self.assertEqual(set(d.local_observations),{'identity'})
            release.set();self.assertTrue(await asyncio.to_thread(finished.wait,1))
            self.assertEqual(set(d.local_observations),{'identity'})
        asyncio.run(run())

class InvalidFrameEvidenceTests(unittest.TestCase):
    def test_matched_full_corrupt_frame_never_publishes_false_power(self):
        async def run():
            n,d=fixture();o.CLOCK[0]+=31;received=[]
            corrupt=frame({**ALL,'1':False},n.seqno,crc_good=False)
            n.socket.frames.append(corrupt)
            native_receive=n._receive
            def receive():
                value=native_receive();d._running=False;return value
            n._receive=receive
            d._children=[SimpleNamespace(on_receive=lambda *args:received.append(args),schedule_update_ha_state=lambda:None)]
            await d.receive_loop()
            self.assertEqual(received,[])
            self.assertEqual(set(d.local_observations),{'identity'})
            self.assertIsNone(d._local_query_ticket)
        asyncio.run(run())

    def test_corrupt_incremental_receive_and_pending_query_reply_are_discarded(self):
        for pending in (False,True):
            n,d=fixture();a=n.seqno
            if pending:
                n.socket.frames.append(frame({'6':49},999,8));d._status_for_local_observations()
            n.socket.frames.append(frame({**ALL,'1':False},a,10 if pending else 8,crc_good=False))
            self.assertIsNone(d._receive_for_local_observations())
            self.assertEqual(set(d.local_observations),{'identity'})
            self.assertIsNone(d._local_query_ticket)

    def test_first_open_status_applies_integrity_before_sync_publication(self):
        for bad in (False,True):
            n,d=fixture();d._running=False;wire=Wire()
            wire.frames.append(frame({**ALL,'1':False},n.seqno,crc_good=not bad))
            o.CLOCK[0]+=31
            with first_open(n,wire):o.Device._refresh_cached_state(d)
            self.assertEqual(wire.connected,('127.0.0.1',6668))
            self.assertEqual('1' in d.local_observations,not bad)
            if not bad:self.assertFalse(d.local_observations['1']['value'])

    def test_first_open_status_applies_integrity_before_continuous_publication(self):
        async def run(bad):
            n,d=fixture();wire=Wire();received=[]
            wire.frames.append(frame({**ALL,'1':False},n.seqno,crc_good=not bad))
            native_receive=n._receive
            def receive():value=native_receive();d._running=False;return value
            n._receive=receive;o.CLOCK[0]+=31
            d._children=[SimpleNamespace(on_receive=lambda *args:received.append(args),schedule_update_ha_state=lambda:None,
                _config=SimpleNamespace(dps=lambda:[]))]
            with first_open(n,wire):await d.receive_loop()
            self.assertEqual(wire.connected,('127.0.0.1',6668))
            self.assertEqual(bool(received),not bad)
        for bad in (False,True):asyncio.run(run(bad))

    def test_shared_source_failed_metadata_conservatively_withdraws(self):
        n,d=fixture();fixture(n,d._local_source_record)
        n.socket.frames.append(frame({**ALL,'1':False},n.seqno,crc_good=False))
        self.assertIsNone(d._status_for_local_observations())
        self.assertEqual(set(d.local_observations),{'identity'})

    def test_child_parent_only_integrity_is_not_borrowed(self):
        n,d=fixture();d.dev_cid='synthetic-child'
        bad_parent=SimpleNamespace(raw_recv=[frame(ALL,999,crc_good=False)],
            _send_receive=lambda *_args,**_kwargs:{'dps':ALL})
        n.parent=bad_parent
        reply=d._status_for_local_observations()
        self.assertIsNotNone(reply)
        self.assertTrue(d._local_reply_full)
        self.assertFalse(d._local_observation_source_exclusive())

    def test_actual_sync_consumer_cannot_cache_or_timestamp_corrupt_power(self):
        n,d=fixture();d._running=False;before=deepcopy(d._cached_state);o.CLOCK[0]+=31
        n.socket.frames.append(frame({**ALL,'1':False},n.seqno,crc_good=False))
        o.Device._refresh_cached_state(d)
        self.assertEqual(d._cached_state,before)
        self.assertTrue(d.get_property('1'),'HA cached request/display is separate from native observations')
        self.assertEqual(set(d.local_observations),{'identity'})

    def test_known_failed_frame_is_rejected_even_in_conservative_overlap_mode(self):
        n,d=fixture();a=n.seqno
        n.socket.frames.append(frame({'6':49},999,8));d._status_for_local_observations()
        n.socket.frames.append(frame({'6':48},998,8));d._status_for_local_observations()
        self.assertTrue(d._local_query_ambiguous)
        n.socket.frames.append(frame({**ALL,'1':False},a,crc_good=False))
        self.assertIsNone(d._receive_for_local_observations())
        self.assertEqual(set(d.local_observations),{'identity'})

    def test_missing_unknown_or_stale_integrity_is_not_guessed_as_failure(self):
        for mode in ('unknown','missing','stale'):
            n,d=fixture();f=frame({**ALL,'1':False},n.seqno)
            if mode=='unknown':f.crc_good=None
            elif mode=='missing':del f.crc_good
            else:
                n.raw_recv=[frame(ALL,999,crc_good=False)]
                n.status=lambda:{'dps':{**ALL,'1':False}}
            if mode!='stale':n.socket.frames.append(f)
            reply=d._status_for_local_observations()
            self.assertIsNotNone(reply,mode)
            self.assertTrue(d._local_reply_full)

    def test_good_integrity_remains_a_genuine_received_report(self):
        n,d=fixture();before=d.local_observations['1']['timestamp'];o.CLOCK[0]+=31
        n.socket.frames.append(frame({**ALL,'1':False},n.seqno))
        reply=d._status_for_local_observations();self.assertTrue(d._local_reply_is_current(reply))
        d._observe_local_dps(reply['dps'],d._local_reply_full)
        self.assertFalse(d.local_observations['1']['value'])
        self.assertGreater(d.local_observations['1']['timestamp'],before)

if __name__=='__main__':unittest.main(verbosity=2)
