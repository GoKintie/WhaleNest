package com.dsh.feiyu;
public class RouteAddressTest {
 static void equal(Object a,Object b){if(!a.equals(b))throw new AssertionError(a+" != "+b);}
 static void invalid(String host,int port){try{RouteAddress.parse(host,port);throw new AssertionError("accepted "+host);}catch(IllegalArgumentException expected){}}
 public static void main(String[] args){
  equal(RouteAddress.parse("whale.example.test",18081).base(),"http://whale.example.test:18081");
  equal(RouteAddress.parse("https://example.test",18081).base(),"https://example.test:18081");
  equal(RouteAddress.parse("example.test",443).base(),"https://example.test:443");
  equal(RouteAddress.parseWan("example.test",8443).base(),"https://example.test:8443");
  try { RouteAddress.parseWan("http://example.test",443); throw new AssertionError("accepted insecure WAN"); }
  catch (IllegalArgumentException expected) {}
  RouteAddress a=RouteAddress.parse("http://example.test:18081/",3081);
  equal(a.port,18081);equal(RouteAddress.parse(a.originHost,16080).base(),"http://example.test:16080");
  equal(RouteAddress.parse("http://[::1]",3081).base(),"http://[::1]:3081");
  invalid("http://user:pass@example.test",3081);invalid("http://example.test/?t=token",3081);invalid("http://example.test/path",3081);invalid("file:///test",3081);invalid("http://example.test",0);
  equal(RouteAddress.normalizeToken("访问密码： `fixed-test`"),"fixed-test");
  equal(RouteAddress.normalizeToken("http://example.test/?t=fixed-test"),"fixed-test");
  if(RouteAddress.tokenError("c2a8…ef0a").isEmpty()||RouteAddress.tokenError("中文test").isEmpty())throw new AssertionError("invalid token accepted");
  equal(RouteAddress.sameOrigin("http://example.test/a","http://example.test:80"),true);
  equal(RouteAddress.sameOrigin("https://example.test/a","http://example.test:80"),false);
  System.out.println("PASS: route protocols, embedded ports, IPv6, origins, malformed token rejection");
 }
}
