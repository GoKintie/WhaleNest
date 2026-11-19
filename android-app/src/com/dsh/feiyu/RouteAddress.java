package com.dsh.feiyu;
import java.net.URI;
import java.net.URLDecoder;
public final class RouteAddress {
 public final String originHost; public final int port;
 private RouteAddress(String host,int port){this.originHost=host;this.port=port;}
 public static RouteAddress parse(String input,int port){
  String text=input==null?"":input.trim();if(text.isEmpty())throw new IllegalArgumentException("请先填写服务器地址");
  if(!text.contains("://"))text=(port==443?"https://":"http://")+text;
  try{URI u=new URI(text);String scheme=u.getScheme(),host=u.getHost();if(!("http".equalsIgnoreCase(scheme)||"https".equalsIgnoreCase(scheme))||host==null||u.getUserInfo()!=null)throw new IllegalArgumentException("地址需为 http:// 或 https://，不包含密码");
   if(u.getRawQuery()!=null||u.getRawFragment()!=null||u.getPath()!=null&&!u.getPath().isEmpty()&&!u.getPath().equals("/"))throw new IllegalArgumentException("地址只填写服务器入口，不包含页面路径或令牌");
   int selected=u.getPort()>0?u.getPort():port;if(selected<1||selected>65535)throw new IllegalArgumentException("端口需为 1–65535");
   if(host.indexOf(':')>=0&&!host.startsWith("["))host="["+host+"]";
   return new RouteAddress(scheme.toLowerCase()+"://"+host,selected);
  }catch(IllegalArgumentException e){throw e;}catch(Exception e){throw new IllegalArgumentException("服务器地址格式不正确");}
 }
 public String base(){return originHost+":"+port;}
 public static RouteAddress parseWan(String input,int port){
  String text=input==null?"":input.trim();
  if(!text.isEmpty()&&!text.contains("://"))text="https://"+text;
  RouteAddress address=parse(text,port);
  if(!address.originHost.startsWith("https://"))throw new IllegalArgumentException("公网入口必须使用 HTTPS");
  return address;
 }
 public static String normalizeToken(String value){
  String text=value==null?"":value.replaceAll("[\\u200b-\\u200f\\ufeff]","").trim();
  if(text.matches("(?i)^https?://.*")){try{String q=new URI(text).getRawQuery();text="";if(q!=null)for(String part:q.split("&")){if(part.startsWith("t=")){text=URLDecoder.decode(part.substring(2),"UTF-8");break;}}}catch(Exception ignored){}}
  text=text.replaceFirst("(?i)^(管理令牌|访问令牌|访问密码|鲸鱼窝密码|WEB_TOKEN)\\s*[:：=]\\s*","").trim();
  if(text.length()>1&&((text.startsWith("`")&&text.endsWith("`"))||(text.startsWith("\"")&&text.endsWith("\""))))text=text.substring(1,text.length()-1);
  return text.trim();
 }
 public static String tokenError(String value){String t=normalizeToken(value);if(t.isEmpty())return "";if(t.matches("(?i)^[a-z0-9]{2,8}(…|\\.\\.\\.)[a-z0-9]{2,8}$"))return "不能使用日志里的缩略号密钥，请输入固定密码";if(!t.matches("^[\\x20-\\x7e]{1,256}$"))return "密码含中文或特殊字符，请仅粘贴完整密码";return "";}
 public static boolean sameOrigin(String actual,String expected){try{URI a=new URI(actual),e=new URI(expected);int ap=a.getPort()>0?a.getPort():("https".equals(a.getScheme())?443:80),ep=e.getPort()>0?e.getPort():("https".equals(e.getScheme())?443:80);return e.getHost()!=null&&e.getHost().equalsIgnoreCase(a.getHost())&&e.getScheme().equalsIgnoreCase(a.getScheme())&&ap==ep;}catch(Exception ignored){return false;}}
}
