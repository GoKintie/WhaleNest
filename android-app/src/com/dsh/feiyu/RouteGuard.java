package com.dsh.feiyu;
/** Discards network results from an earlier route and respects an explicit route choice. */
public final class RouteGuard {
 private int revision; private boolean manual;
 public RouteGuard(boolean manual){this.manual=manual;}
 public synchronized int revision(){return revision;}
 public synchronized boolean isCurrent(int expected){return revision==expected;}
 public synchronized boolean isManual(){return manual;}
 public synchronized void pin(){manual=true;revision++;}
 public synchronized boolean acceptAutomatic(int expected){if(manual||revision!=expected)return false;revision++;return true;}
}
