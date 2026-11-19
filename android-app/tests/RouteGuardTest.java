package com.dsh.feiyu;
public class RouteGuardTest {
 static void check(boolean b){if(!b)throw new AssertionError();}
 public static void main(String[] a){
  RouteGuard g=new RouteGuard(false);int startup=g.revision();g.pin();check(!g.acceptAutomatic(startup));check(!g.isCurrent(startup));check(g.isManual());
  int manual=g.revision();check(!g.acceptAutomatic(manual));check(g.isCurrent(manual));
  RouteGuard auto=new RouteGuard(false);int first=auto.revision();check(auto.acceptAutomatic(first));check(!auto.acceptAutomatic(first));
  RouteGuard restored=new RouteGuard(true);check(!restored.acceptAutomatic(restored.revision()));
  System.out.println("PASS: manual route persists, stale startup/health switches rejected, automatic result applied once");
 }
}
