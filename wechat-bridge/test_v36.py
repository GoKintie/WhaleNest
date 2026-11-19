import unittest,asyncio,sqlite3,hashlib
from unittest.mock import patch
from urllib.parse import parse_qs
from drivers.wechat_linux import WeChatLinuxDriver
from idmap import IdMap
from onebot import OneBotServer,ActionFailed
from media_auth import sign,verify
class BridgeSafetyTests(unittest.IsolatedAsyncioTestCase):
 def driver(self):
  d=WeChatLinuxDriver({'wechat':{'self_wxid':'self'}},IdMap(''));d._names={'peer':'Peer'};d._resolve=lambda _: 'peer';d._display=lambda _: 'Peer';return d
 async def test_unsupported_segment_validated_before_any_send(self):
  d=self.driver();calls=[];d._do_send=lambda *args:calls.append(args)
  with self.assertRaisesRegex(ValueError,'unsupported'):
   await d.send('private',123,[{'type':'text','data':{'text':'first'}},{'type':'record','data':{'file':'internal.wav'}}])
  self.assertEqual(calls,[])
 async def test_text_requires_confirmed_receipt(self):
  d=self.driver();d._do_send=lambda *args:False
  with self.assertRaisesRegex(RuntimeError,'unknown'):await d.send('private',123,[{'type':'text','data':{'text':'hello'}}])
  d._do_send=lambda *args:True
  self.assertIsInstance(await d.send('private',123,[{'type':'text','data':{'text':'hello'}}]),int)
 async def test_missing_driver_ack_never_succeeds(self):
  class NoAck:
   async def send(self,*args):return None
  s=OneBotServer({'server':{},'bot':{}},IdMap(''));s.driver=NoAck()
  with self.assertRaises(ActionFailed) as cm:await s.dispatch('send_private_msg',{'user_id':123,'message':'hello'})
  self.assertEqual(cm.exception.retcode,1201)
 def test_outgoing_confirmation_requires_self_sender_and_type(self):
  d=self.driver();table='Msg_'+hashlib.md5(b'peer').hexdigest()
  def connect(_):
   con=sqlite3.connect(':memory:');con.execute('CREATE TABLE Name2Id(user_name TEXT)');con.executemany('INSERT INTO Name2Id VALUES(?)',[('self',),('peer',)]);con.execute('CREATE TABLE '+table+'(local_id INT,local_type INT,message_content TEXT,real_sender_id INT)');con.executemany('INSERT INTO '+table+' VALUES(?,?,?,?)',[(9,1,'hello',2),(10,3,'image',1),(11,1,'hello',1)]);return con
  d._connect=connect
  self.assertTrue(d._verify_outgoing('peer',10,1,'hello',.01));self.assertFalse(d._verify_outgoing('peer',11,1,'hello',.01));self.assertFalse(d._verify_outgoing('peer',9,1,'image',.01))
 def test_image_rejects_remote_or_nonimage_data_before_clipboard(self):
  d=self.driver()
  with self.assertRaisesRegex(ValueError,'agent artifact'):d._send_image('peer','Peer','https://untrusted.invalid/file.png')
  class Response:
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,*args):return b'GIF89a'
  with patch('urllib.request.urlopen',return_value=Response()):
   with self.assertRaisesRegex(ValueError,'PNG/JPEG'):d._send_image('peer','Peer','http://dsh-onebot:3081/api/raw?path=a.gif')
 def test_media_signature_is_path_bound(self):
  q={k:v[0] for k,v in parse_qs(sign('image.png')).items()};self.assertTrue(verify('image.png',q));self.assertFalse(verify('other.png',q));self.assertFalse(verify('image.png',{'expires':'0','sig':q['sig']}))

 def test_only_verified_quote_of_self_becomes_group_mention(self):
  room = 'test@chatroom'
  table = 'Msg_' + hashlib.md5(room.encode()).hexdigest()
  driver = WeChatLinuxDriver({'wechat': {'self_wxid': 'wxid_bot'}}, IdMap(''))
  driver._md5map[table[4:]] = room
  driver._aliases['wxid_bot'] = 'bot_alias'
  driver._last[table] = 2
  con = sqlite3.connect(':memory:')
  con.execute('CREATE TABLE Name2Id(user_name TEXT)')
  con.executemany('INSERT INTO Name2Id VALUES(?)', [('wxid_bot',), ('wxid_peer',)])
  con.execute(f'CREATE TABLE {table}(local_id INT, create_time INT, real_sender_id INT, '
              'local_type INT, message_content TEXT, server_id INT)')
  con.executemany(f'INSERT INTO {table} VALUES(?,?,?,?,?,?)', [
      (1, 100, 1, 1, '原消息', 901), (2, 100, 2, 1, '原消息', 902),
  ])
  for lid, source_room, quoted_author, quoted_id in [
      (3, room, 'wxid_bot', 901),
      (4, room, 'wxid_peer', 902),
      (5, room, 'wxid_bot', 902),
      (6, 'other@chatroom', 'wxid_bot', 901),
      (7, room, 'wxid_bot', 999),
  ]:
   xml = (f'<msg><appmsg><title>接着说</title><type>57</type><refermsg>'
          f'<fromusr>{source_room}</fromusr><chatusr>{quoted_author}</chatusr>'
          f'<svrid>{quoted_id}</svrid></refermsg></appmsg></msg>')
   con.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?)',
               (lid, 101, 2, (57 << 32) | 49, 'wxid_peer:\n' + xml, lid + 1000))
  driver._connect = lambda _: con
  server = OneBotServer({}, IdMap(''))
  server.self_id = driver.login_info()['user_id']
  events = [server.to_onebot_message(message) for message in driver._poll_once()]
  self.assertEqual(len(events), 5)
  self.assertEqual(events[0]['message'], [
      {'type': 'at', 'data': {'qq': events[0]['self_id']}},
      {'type': 'text', 'data': {'text': '[引用回复] 接着说'}},
  ])
  self.assertTrue(all([s['type'] for s in event['message']] == ['text'] for event in events[1:]))

if __name__=='__main__':unittest.main()
