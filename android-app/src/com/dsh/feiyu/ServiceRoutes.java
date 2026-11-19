package com.dsh.feiyu;
public final class ServiceRoutes {
 public static String endpoint(boolean whale,String whaleHost,int whalePort,String napcatHost,int napcatPort){return RouteAddress.parse(whale?whaleHost:napcatHost,whale?whalePort:napcatPort).base();}
}
