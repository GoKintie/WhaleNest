import unittest
from drivers.wechat_linux import WeChatLinuxDriver
from idmap import IdMap

class ContactIdentityTests(unittest.TestCase):
 def test_list_inbound_and_send_use_same_identity(self):
  d=WeChatLinuxDriver({'wechat':{}},IdMap(''))
  d._names={'wxid_peer':'微信好友','room@chatroom':'微信群'}
  d._aliases={'wxid_peer':'peer_alias'};d._a2w={'peer_alias':'wxid_peer'}
  friend=d.friends()[0]
  self.assertEqual(friend['user_id'],d._uid('wxid_peer'))
  self.assertEqual(d._resolve(friend['user_id']),'wxid_peer')
  self.assertEqual(d._resolve(friend['legacy_user_id']),'wxid_peer')
  self.assertEqual(d._resolve('room@chatroom'),'room@chatroom')
  self.assertEqual(len(d.friends()),1)
 def test_without_alias_keeps_existing_wxid_scope(self):
  d=WeChatLinuxDriver({'wechat':{}},IdMap(''));d._names={'wxid_peer':'好友'}
  self.assertEqual(d.friends()[0]['user_id'],'wxid_peer')
  self.assertEqual(d._resolve('wxid_peer'),'wxid_peer')

if __name__=='__main__':unittest.main()
