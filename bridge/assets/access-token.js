(function(root){
  function normalize(value){
    let text=String(value||'').replace(/[\u200b-\u200f\ufeff]/g,'').trim()
    if(/^https?:\/\//i.test(text)){try{text=new URL(text).searchParams.get('t')||''}catch{}}
    text=text.replace(/^(?:管理令牌|访问令牌|访问密码|鲸鱼窝密码|WEB_TOKEN)\s*[:：=]\s*/i,'').trim()
    if((text.startsWith('`')&&text.endsWith('`'))||(text.startsWith('"')&&text.endsWith('"')))text=text.slice(1,-1)
    return text.trim()
  }
  function error(value){
    const text=normalize(value)
    if(!text)return '请输入固定密码或完整访问令牌'
    if(/^[a-z0-9]{2,8}(?:\u2026|\.{3})[a-z0-9]{2,8}$/i.test(text))return '这是日志中的缩略显示，不能登录。请使用固定密码或完整令牌'
    if(!/^[\x20-\x7e]{1,256}$/.test(text))return '密码中含中文、换行或特殊字符，请粘贴密码本身；不要粘贴日志说明或缩略号'
    return ''
  }
  root.WhaleAuth={normalize,error}
})(globalThis)
