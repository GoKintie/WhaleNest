package com.dsh.feiyu;
public class ServiceRoutesTest {
 static void eq(String a,String b){if(!a.equals(b))throw new AssertionError(a+" != "+b);}
 public static void main(String[] args){
  eq(ServiceRoutes.endpoint(true,"https://whale.example.test",443,"https://napcat.example.test",443),"https://whale.example.test:443");
  eq(ServiceRoutes.endpoint(false,"https://whale.example.test",443,"https://napcat.example.test",443),"https://napcat.example.test:443");
  eq(ServiceRoutes.endpoint(false,"http://198.51.100.10",18081,"http://198.51.100.10",16080),"http://198.51.100.10:16080");
  eq(ServiceRoutes.endpoint(true,"http://192.0.2.20",3081,"http://192.0.2.20",6099),"http://192.0.2.20:3081");
  System.out.println("PASS: distinct services on the same HTTPS port, legacy WAN and LAN routing");
 }
}
