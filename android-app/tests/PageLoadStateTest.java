package com.dsh.feiyu;
public class PageLoadStateTest {
 static void check(boolean b){if(!b)throw new AssertionError();}
 public static void main(String[] a){
  PageLoadState p=new PageLoadState();int first=p.start();check(p.waiting(first));p.stage("加载结束");check(p.waiting(first));
  int next=p.start();check(!p.content(first,true));check(p.waiting(next));check(p.content(next,false));check(!p.ready);
  p.fail("ERROR_CONNECT -6");check(!p.content(next,true));check(!p.ready);check(!p.waiting(next));
  int last=p.start();check(p.content(last,true));check(p.ready);check(!p.waiting(last));
  System.out.println("PASS: no-callback timeout, finished-but-empty page, stale callbacks, error recovery");
 }
}
