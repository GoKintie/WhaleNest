import hashlib,hmac,secrets,time
from urllib.parse import urlencode
_secret=secrets.token_bytes(32)
def sign(name):
    expires=int(time.time())+1800
    sig=hmac.new(_secret,f'{name}\n{expires}'.encode(),hashlib.sha256).hexdigest()
    return urlencode({'expires':expires,'sig':sig})
def verify(name,query):
    try: expires=int(query.get('expires','0'))
    except ValueError:return False
    if expires<time.time() or expires>time.time()+3600:return False
    want=hmac.new(_secret,f'{name}\n{expires}'.encode(),hashlib.sha256).hexdigest()
    return hmac.compare_digest(want,query.get('sig',''))
