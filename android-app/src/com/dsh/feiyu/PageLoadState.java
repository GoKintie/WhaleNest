package com.dsh.feiyu;
public final class PageLoadState {
 private int generation;public boolean ready,failed;public String page="尚未打开",network="尚未检查";
 public int start(){generation++;ready=false;failed=false;page="请求已发出";network="检查中";return generation;}
 public int generation(){return generation;}
 public void stage(String value){if(!failed)page=value;}
 public void fail(String value){failed=true;ready=false;page=value;}
 public boolean content(int expected,boolean present){if(expected!=generation||failed)return false;ready=present;page=present?"页面内容已返回":"页面返回为空";return true;}
 public boolean waiting(int expected){return generation==expected&&!ready&&!failed;}
}
