package com.dsh.feiyu;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity implements View.OnClickListener, DownloadListener {

    private static final String PREFS_NAME = "feiyu_pocket_prefs";

    // 内网默认参数 (LAN)
    static final String DEFAULT_LAN_HOST = "192.0.2.20";
    static final int DEFAULT_LAN_FEIYU_PORT = 3081;
    static final int DEFAULT_LAN_NAPCAT_PORT = 6099;

    // 占位地址用于首次配置。
    static final String DEFAULT_WAN_HOST = "https://whale.example.test";
    static final int DEFAULT_WAN_FEIYU_PORT = 443;
    static final int DEFAULT_WAN_NAPCAT_PORT = 443;

    static final String DEFAULT_FEIYU_TOKEN = "";
    static final String DEFAULT_NAPCAT_TOKEN = "";
    static final int FILE_CHOOSER_REQ = 1001;

    private static final int ID_TAB_FEIYU = 101;
    private static final int ID_TAB_NAPCAT = 102;
    private static final int ID_STATUS_BOX = 103;
    private static final int ID_BTN_LINE = 104;
    private static final int ID_BTN_RELOAD = 105;
    private static final int ID_BTN_CFG = 106;
    private static final int ID_DIAG=107,ID_BROWSER=108,ID_RETRY=109,ID_WAN_IP=110;

    private SharedPreferences prefs;
    Handler mainHandler;
    ExecutorService bgPool;

    // 双线配置：useWan=false 走局域网，useWan=true 走公网 VPS
    boolean useWan = false;
    RouteGuard routeGuard;
    String lanHost;
    int lanFeiyuPort;
    int lanNapcatPort;
    String wanHost;
    String wanNapcatHost;
    int wanFeiyuPort;
    int wanNapcatPort;

    String feiyuToken;
    String napcatToken;
    volatile String napcatCredential = "";

    int activeTab = 0; // 0 = 肥鱼, 1 = NapCat
    TextView connectionLine,connectionDetail;LinearLayout connectionPanel;FrameLayout webContainer;
    final PageLoadState[] pageStates={new PageLoadState(),new PageLoadState()};
    final boolean[] rendererGone={false,false};boolean detailsRequested=false;
    WebView webFeiyu;
    WebView webNapcat;
    ProgressBar progressBar;

    private TextView tabFeiyuBtn;
    private TextView tabNapcatBtn;
    View statusDot;
    TextView hostLabel;
    TextView btnLine;

    ValueCallback<Uri[]> filePathCallback;
    private long lastBackPress = 0;
    final AtomicBoolean scanning = new AtomicBoolean(false);
    Runnable healthCheckTask;

    EditText dlgInpLanHost;
    EditText dlgInpLanFPort;
    EditText dlgInpLanNPort;
    EditText dlgInpWanHost;
    EditText dlgInpWanNHost;
    EditText dlgInpWanFPort;
    EditText dlgInpWanNPort;
    EditText dlgInpFToken;
    EditText dlgInpNToken;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        mainHandler = new Handler(Looper.getMainLooper());
        bgPool = Executors.newCachedThreadPool();
        healthCheckTask = new HealthLoopTask(this);

        loadConfig();
        routeGuard=new RouteGuard(prefs.getBoolean("route_manual",prefs.contains("use_wan")));
        setupStatusBar();
        setContentView(buildRootLayout());

        initWebView(webFeiyu, true);
        initWebView(webNapcat, false);

        switchTab(0);
        // 启动时自动探测最优线路（优先内网，内网不通 0.55s 自动切公网 VPS）
        if(routeGuard.isManual()){loadBothPages();checkServerHealth(false);}else bgPool.execute(new SmartBootRouteWorker(this));
        mainHandler.postDelayed(healthCheckTask, 12000);
    }

    String activeHost() {
        return useWan ? wanHost : lanHost;
    }

    int activeFeiyuPort() {
        return useWan ? wanFeiyuPort : lanFeiyuPort;
    }

    int activeNapcatPort() {
        return useWan ? wanNapcatPort : lanNapcatPort;
    }

    String currentRouteBadge() {
        return (useWan ? "公网 " : "内网 ") + activeHost();
    }

    private void loadConfig() {
        useWan = prefs.getBoolean("use_wan", false);
        lanHost = prefs.getString("lan_host", prefs.getString("nas_host", DEFAULT_LAN_HOST));
        lanFeiyuPort = prefs.getInt("lan_feiyu_port", DEFAULT_LAN_FEIYU_PORT);
        lanNapcatPort = prefs.getInt("lan_napcat_port", DEFAULT_LAN_NAPCAT_PORT);

        wanHost = prefs.getString("wan_host", DEFAULT_WAN_HOST);
        if (wanHost == null || wanHost.trim().isEmpty()) {
            wanHost = DEFAULT_WAN_HOST;
            prefs.edit().putString("wan_host", wanHost).apply();
        }
        wanFeiyuPort = prefs.getInt("wan_feiyu_port", DEFAULT_WAN_FEIYU_PORT);
        wanNapcatPort = prefs.getInt("wan_napcat_port", DEFAULT_WAN_NAPCAT_PORT);
        wanNapcatHost=prefs.getString("wan_napcat_host",wanHost);
        if(wanNapcatHost==null||wanNapcatHost.trim().isEmpty())wanNapcatHost=wanHost;

        feiyuToken = readToken("feiyu_token", DEFAULT_FEIYU_TOKEN);
        napcatToken = readToken("napcat_token", DEFAULT_NAPCAT_TOKEN);
        try{RouteAddress l=RouteAddress.parse(lanHost,lanFeiyuPort),w=RouteAddress.parse(wanHost,wanFeiyuPort);lanHost=l.originHost;lanFeiyuPort=l.port;wanHost=w.originHost;wanFeiyuPort=w.port;RouteAddress n=RouteAddress.parse(wanNapcatHost,wanNapcatPort);wanNapcatHost=n.originHost;wanNapcatPort=n.port;}catch(IllegalArgumentException ignored){}
        feiyuToken=RouteAddress.normalizeToken(feiyuToken);napcatToken=RouteAddress.normalizeToken(napcatToken);
        if(!RouteAddress.tokenError(feiyuToken).isEmpty())feiyuToken="";
        if(!RouteAddress.tokenError(napcatToken).isEmpty())napcatToken="";
    }

    private String readToken(String field, String fallback) {
        try {
            return TokenVault.read(prefs, field, fallback);
        } catch (Exception error) {
            Toast.makeText(this, "无法读取已保存的令牌，请在设置中重新填写", Toast.LENGTH_LONG).show();
            return "";
        }
    }

    void saveAllConfig(boolean nextUseWan, String lHost, int lFP, int lNP,
                       String wHost, int wFP, int wNP, String fTok, String nTok) {
        saveAllConfig(nextUseWan,lHost,lFP,lNP,wHost,wFP,wNP,fTok,nTok,wanNapcatHost);
    }
    void saveAllConfig(boolean nextUseWan,String lHost,int lFP,int lNP,String wHost,int wFP,int wNP,String fTok,String nTok,String nHost){
        RouteAddress lan=RouteAddress.parse(lHost.trim().isEmpty()?DEFAULT_LAN_HOST:lHost,lFP),wan=RouteAddress.parseWan(wHost.trim().isEmpty()?DEFAULT_WAN_HOST:wHost,wFP);
        RouteAddress napcat=RouteAddress.parseWan(nHost==null||nHost.trim().isEmpty()?wan.originHost:nHost,wNP);
        String f=RouteAddress.normalizeToken(fTok),n=RouteAddress.normalizeToken(nTok);
        if(!RouteAddress.tokenError(f).isEmpty())throw new IllegalArgumentException(RouteAddress.tokenError(f));
        if(!RouteAddress.tokenError(n).isEmpty())throw new IllegalArgumentException(RouteAddress.tokenError(n));
        if(lNP<1||lNP>65535||wNP<1||wNP>65535)throw new IllegalArgumentException("NapCat 端口需为 1–65535");
        SharedPreferences.Editor edit = prefs.edit();
        try {
            TokenVault.write(edit, "feiyu_token", f);
            TokenVault.write(edit, "napcat_token", n);
        } catch (Exception error) {
            throw new IllegalArgumentException("无法加密保存令牌，请检查系统密钥库");
        }
        routeGuard.pin();
        useWan = nextUseWan;
        lanHost = lHost.trim().isEmpty() ? DEFAULT_LAN_HOST : lHost.trim();
        lanFeiyuPort = lFP;
        lanNapcatPort = lNP;
        wanHost = wHost.trim().isEmpty() ? DEFAULT_WAN_HOST : wHost.trim();
        wanFeiyuPort = wFP;
        wanNapcatHost=napcat.originHost;wanNapcatPort=napcat.port;
        lanHost=lan.originHost;lanFeiyuPort=lan.port;wanHost=wan.originHost;wanFeiyuPort=wan.port;
        feiyuToken = f;
        napcatToken = n;
        napcatCredential = "";

        edit
                .putBoolean("route_manual", true)
                .putBoolean("use_wan", useWan)
                .putString("lan_host", lanHost)
                .putInt("lan_feiyu_port", lanFeiyuPort)
                .putInt("lan_napcat_port", lanNapcatPort)
                .putString("wan_host", wanHost)
                .putInt("wan_feiyu_port", wanFeiyuPort)
                .putString("wan_napcat_host",wanNapcatHost)
                .putInt("wan_napcat_port", wanNapcatPort)
                .apply();
        updateRouteLabels();
    }

    void setUseWanMode(boolean nextUseWan) {
        routeGuard.pin();
        useWan = nextUseWan;
        napcatCredential = "";
        prefs.edit().putBoolean("route_manual",true).putBoolean("use_wan", useWan).apply();
        updateRouteLabels();
    }

    void updateRouteLabels() {
        if (hostLabel != null) {
            hostLabel.setText(currentRouteBadge());
        }
        if (btnLine != null) {
            btnLine.setText(useWan ? "切内网" : "切公网");
        }
    }

    private void setupStatusBar() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.parseColor("#11141A"));
            window.setNavigationBarColor(Color.parseColor("#11141A"));
        }
    }

    int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    GradientDrawable pillBg(int fillColor, int strokeColor, float radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fillColor);
        d.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) {
            d.setStroke(dp(1), strokeColor);
        }
        return d;
    }

    GradientDrawable gradientPillBg(int startColor, int endColor, float radiusDp) {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{startColor, endColor}
        );
        d.setCornerRadius(dp(radiusDp));
        return d;
    }

    private View buildRootLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#090B10"));

        // FlClash + NapCat HeroUI 风格悬浮胶囊顶栏（0 Emoji，圆润紧凑）
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setPadding(dp(8), dp(6), dp(8), dp(6));
        topBar.setBackgroundColor(Color.parseColor("#0D1017"));

        LinearLayout switcher = new LinearLayout(this);
        switcher.setOrientation(LinearLayout.HORIZONTAL);
        switcher.setPadding(dp(2.5f), dp(2.5f), dp(2.5f), dp(2.5f));
        switcher.setBackground(pillBg(Color.parseColor("#161B26"), Color.parseColor("#262F40"), 10));

        tabFeiyuBtn = new TextView(this);
        tabFeiyuBtn.setId(ID_TAB_FEIYU);
        tabFeiyuBtn.setText("鲸鱼窝");
        tabFeiyuBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        tabFeiyuBtn.setTypeface(Typeface.DEFAULT_BOLD);
        tabFeiyuBtn.setPadding(dp(11), dp(4.5f), dp(11), dp(4.5f));
        tabFeiyuBtn.setOnClickListener(this);

        tabNapcatBtn = new TextView(this);
        tabNapcatBtn.setId(ID_TAB_NAPCAT);
        tabNapcatBtn.setText("NapCat");
        tabNapcatBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        tabNapcatBtn.setTypeface(Typeface.DEFAULT_BOLD);
        tabNapcatBtn.setPadding(dp(10), dp(4.5f), dp(10), dp(4.5f));
        tabNapcatBtn.setOnClickListener(this);

        switcher.addView(tabFeiyuBtn);
        switcher.addView(tabNapcatBtn);
        topBar.addView(switcher);

        // 中间 FlClash 胶囊状态指示器 + 完整线路与地址显示
        LinearLayout statusBox = new LinearLayout(this);
        statusBox.setId(ID_STATUS_BOX);
        statusBox.setOrientation(LinearLayout.HORIZONTAL);
        statusBox.setGravity(Gravity.CENTER_VERTICAL);
        statusBox.setPadding(dp(9), dp(4.5f), dp(6), dp(4.5f));
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        statusLp.leftMargin = dp(6);
        statusLp.rightMargin = dp(6);
        statusBox.setLayoutParams(statusLp);
        statusBox.setBackground(pillBg(Color.parseColor("#141923"), Color.parseColor("#222A3A"), 9));
        statusBox.setOnClickListener(this);

        statusDot = new View(this);
        LinearLayout.LayoutParams dotLp = new LinearLayout.LayoutParams(dp(7), dp(7));
        dotLp.rightMargin = dp(6);
        statusDot.setLayoutParams(dotLp);
        statusDot.setBackground(pillBg(Color.parseColor("#64748B"), 0, 4));

        hostLabel = new TextView(this);
        hostLabel.setText(currentRouteBadge());
        hostLabel.setTextColor(Color.parseColor("#E2E8F0"));
        hostLabel.setTypeface(Typeface.MONOSPACE);
        hostLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.8f);
        hostLabel.setSingleLine(true);

        statusBox.addView(statusDot);
        statusBox.addView(hostLabel);
        topBar.addView(statusBox);

        // 右侧三个纯文字圆角胶囊按钮
        btnLine = makeTextButton(useWan ? "切内网" : "切公网", ID_BTN_LINE, 0);
        TextView btnReload = makeTextButton("刷新", ID_BTN_RELOAD, dp(4));
        TextView btnCfg = makeTextButton("设置", ID_BTN_CFG, dp(4));

        topBar.addView(btnLine);
        topBar.addView(btnReload);
        topBar.addView(btnCfg);
        root.addView(topBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout infoRow=new LinearLayout(this);infoRow.setGravity(Gravity.CENTER_VERTICAL);infoRow.setPadding(dp(10),dp(5),dp(8),dp(5));
        connectionLine=new TextView(this);connectionLine.setTextColor(Color.parseColor("#CBD5E1"));connectionLine.setTextSize(11);connectionLine.setText("APK 3.6.5 · 正在准备连接");
        infoRow.addView(connectionLine,new LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1f));
        infoRow.addView(makeTextButton("诊断",ID_DIAG,dp(4)));infoRow.addView(makeTextButton("浏览器",ID_BROWSER,dp(4)));root.addView(infoRow);
        connectionPanel=new LinearLayout(this);connectionPanel.setOrientation(LinearLayout.VERTICAL);connectionPanel.setPadding(dp(16),dp(12),dp(16),dp(14));
        connectionDetail=new TextView(this);connectionDetail.setTextColor(Color.parseColor("#CBD5E1"));connectionDetail.setTextSize(13);connectionDetail.setTextIsSelectable(true);connectionPanel.addView(connectionDetail);
        LinearLayout recoveryRow=new LinearLayout(this);recoveryRow.addView(makeTextButton("重新连接",ID_RETRY,0));recoveryRow.addView(makeTextButton("配置 HTTPS 入口",ID_WAN_IP,dp(8)));connectionPanel.addView(recoveryRow);root.addView(connectionPanel);
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        View divider = new View(this);
        divider.setBackgroundColor(Color.parseColor("#222831"));
        root.addView(divider, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        FrameLayout container = new FrameLayout(this);webContainer=container;
        webFeiyu = new WebView(this);
        webNapcat = new WebView(this);
        container.addView(webNapcat, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        container.addView(webFeiyu, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(container, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return root;
    }

    private TextView makeTextButton(String label, int id, int leftMarginPx) {
        TextView tv = new TextView(this);
        tv.setId(id);
        tv.setText(label);
        tv.setGravity(Gravity.CENTER);
        tv.setTextColor(Color.parseColor("#E8EBF0"));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        tv.setPadding(dp(8), dp(4), dp(8), dp(4));
        tv.setBackground(pillBg(Color.parseColor("#1E242D"), Color.parseColor("#2E3744"), 6));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = leftMarginPx;
        tv.setLayoutParams(lp);
        tv.setOnClickListener(this);
        return tv;
    }

    @Override
    public void onClick(View v) {
        int id = v.getId();
        if(id==ID_DIAG){detailsRequested=!detailsRequested;refreshConnectionInfo();}
        else if(id==ID_WAN_IP){offerVerifiedWanIp();}
        else if(id==ID_BROWSER){openCurrentInBrowser();}
        else if(id==ID_RETRY){loadBothPages();checkServerHealth(false);}
        else if (id == ID_TAB_FEIYU) {
            switchTab(0);
        } else if (id == ID_TAB_NAPCAT) {
            switchTab(1);
        } else if (id == ID_BTN_LINE) {
            setUseWanMode(!useWan);
            loadBothPages();
            checkServerHealth(false);
            Toast.makeText(this, "已切换至" + (useWan ? "公网 VPS 线路 (" + wanHost + ")" : "局域网直连 (" + lanHost + ")"), Toast.LENGTH_SHORT).show();
        } else if (id == ID_BTN_RELOAD) {
            if (activeTab == 0) {
                loadBothPages();
            } else {
                bgPool.execute(new NapcatAuthWorker(this, true));
            }
            checkServerHealth(false);
            Toast.makeText(this, "正在刷新…", Toast.LENGTH_SHORT).show();
        } else if (id == ID_STATUS_BOX || id == ID_BTN_CFG) {
            showSettingsDialog();
        }
    }

    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                String mimetype, long contentLength) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
        }
    }

    private void switchTab(int idx) {
        activeTab=idx;
        tabFeiyuBtn.setTextColor(idx==0?Color.WHITE:Color.parseColor("#94A3B8"));tabNapcatBtn.setTextColor(idx==1?Color.WHITE:Color.parseColor("#94A3B8"));
        tabFeiyuBtn.setBackground(idx==0?gradientPillBg(Color.parseColor("#3B82F6"),Color.parseColor("#6366F1"),8):pillBg(Color.TRANSPARENT,0,8));
        tabNapcatBtn.setBackground(idx==1?gradientPillBg(Color.parseColor("#7C3AED"),Color.parseColor("#EC4899"),8):pillBg(Color.TRANSPARENT,0,8));
        // WebViews use normal visibility; no translated transparent GPU layers.
        if(webFeiyu!=null){webFeiyu.setAlpha(1f);webFeiyu.setTranslationX(0);}
        if(webNapcat!=null){webNapcat.setAlpha(1f);webNapcat.setTranslationX(0);}
        if(webFeiyu!=null)webFeiyu.setVisibility(idx==0?View.VISIBLE:View.GONE);if(webNapcat!=null)webNapcat.setVisibility(idx==1?View.VISIBLE:View.GONE);
        refreshConnectionInfo();
    }

    private void initWebView(final WebView wv, final boolean isFeiyu) {
        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setUserAgentString(ws.getUserAgentString()+" WhaleNest/3.6.5");
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);
        ws.setUseWideViewPort(false);
        ws.setLoadWithOverviewMode(false);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setTextZoom(100);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(wv, false);
        }
        wv.setBackgroundColor(Color.parseColor("#11141A"));
        wv.setWebViewClient(new PocketWebViewClient(this, isFeiyu));
        wv.setWebChromeClient(new PocketChromeClient(this, isFeiyu));
        wv.setDownloadListener(this);
    }

    String escapeJs(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\"", "\\\"").replace("\n", "");
    }

    void injectFeiyuAuth(WebView view) {
        if(!trustedOrigin(view.getUrl(),true))return;
        final String tok = escapeJs(feiyuToken);
        if (tok.isEmpty()) return;
        String js = "(function(){try{" +
                "if(localStorage.getItem('dsh_token')!=='" + tok + "'){" +
                "localStorage.setItem('dsh_token','" + tok + "');" +
                "}" +
                "var g=document.getElementById('gate');" +
                "if(g&&g.classList.contains('on')){" +
                "var inp=document.getElementById('gateInput');" +
                "var btn=document.getElementById('gateOk');" +
                "if(inp&&btn){inp.value='" + tok + "';btn.click();}" +
                "}" +
                "}catch(e){}})();";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            view.evaluateJavascript(js, null);
        } else {
            view.loadUrl("javascript:" + js);
        }
    }

    void injectNapcatAuth(WebView view) {
        if(!trustedOrigin(view.getUrl(),false))return;
        final String cred = escapeJs(napcatCredential);
        String js = "(function(){try{" +
                "var cur=localStorage.getItem('token');" +
                "if(cur&&cur.charAt(0)!=='\"'){localStorage.removeItem('token');cur=null;}" +
                "var cred='" + cred + "';" +
                "if(cred){" +
                "var target='\"'+cred+'\"';" +
                "if(cur!==target){" +
                "localStorage.setItem('token',target);" +
                "if(location.pathname.indexOf('login')>=0||!document.getElementById('root')||document.getElementById('root').innerHTML===''){" +
                "location.replace('/webui/');" +
                "}" +
                "}" +
                "}" +
                "}catch(e){}})();";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            view.evaluateJavascript(js, null);
        } else {
            view.loadUrl("javascript:" + js);
        }
    }

    static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    String endpointBase(boolean whale){
        if(useWan)return RouteAddress.parseWan(whale?wanHost:wanNapcatHost,whale?wanFeiyuPort:wanNapcatPort).base();
        return ServiceRoutes.endpoint(whale,lanHost,lanFeiyuPort,lanHost,lanNapcatPort);
    }
    boolean trustedOrigin(String url,boolean feiyu){try{return RouteAddress.sameOrigin(url,endpointBase(feiyu));}catch(Exception e){return false;}}
    int webIndex(WebView view){return view==webNapcat?1:0;}
    boolean currentWeb(WebView view){return view!=null&&(view==webFeiyu||view==webNapcat);}
    String safeDetail(String value){String t=value==null?"未知错误":value;if(feiyuToken!=null&&!feiyuToken.isEmpty())t=t.replace(feiyuToken,"[已隐藏]").replace(Uri.encode(feiyuToken),"[已隐藏]");if(napcatToken!=null&&!napcatToken.isEmpty())t=t.replace(napcatToken,"[已隐藏]").replace(Uri.encode(napcatToken),"[已隐藏]");return t.length()>700?t.substring(0,700):t;}
    void showConnectionError(WebView view,String detail){if(!currentWeb(view))return;pageStates[webIndex(view)].fail(safeDetail(detail));refreshConnectionInfo();}
    void pageStage(WebView view,String text){if(!currentWeb(view))return;pageStates[webIndex(view)].stage(text);refreshConnectionInfo();}
    void refreshConnectionInfo(){
        if(connectionLine==null)return;PageLoadState state=pageStates[activeTab];
        connectionLine.setText("APK 3.6.5 · "+(useWan?"公网":"内网")+" · "+(activeTab==0?"鲸鱼窝":"NapCat"));
        String endpoint;try{endpoint=endpointBase(activeTab==0);}catch(Exception e){endpoint="地址无效";}
        String engine="未知";try{if(Build.VERSION.SDK_INT>=26){android.content.pm.PackageInfo info=WebView.getCurrentWebViewPackage();if(info!=null)engine=info.packageName+" "+info.versionName;}}catch(Exception ignored){}
        connectionDetail.setText("入口："+endpoint+"\n网络："+state.network+"\n网页："+state.page+"\nWebView："+engine);
        connectionPanel.setVisibility(detailsRequested||!state.ready?View.VISIBLE:View.GONE);
    }
    void openCurrentInBrowser(){try{String base=endpointBase(activeTab==0);startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(base+(activeTab==0?"/":"/webui/"))));}catch(Exception e){Toast.makeText(this,"无法打开浏览器，请检查入口设置",Toast.LENGTH_LONG).show();}}
    void networkResult(int index,String text,int revision){mainHandler.post(new NativeNetworkRunner(this,index,safeDetail(text),revision));}
    void beginPage(int index){int generation=pageStates[index].start();refreshConnectionInfo();mainHandler.postDelayed(new PageWatchdog(this,index,generation),25000);}
    void recoverRenderer(int index){
        if(!rendererGone[index])return;WebView fresh=new WebView(this);initWebView(fresh,index==0);
        if(index==0)webFeiyu=fresh;else webNapcat=fresh;
        webContainer.addView(fresh,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));rendererGone[index]=false;switchTab(activeTab);
    }
    void offerVerifiedWanIp(){ showSettingsDialog(); }
    void routeStatus(int state,String label,int revision){mainHandler.post(new RouteStatusRunner(this,state,label,revision));}

    String buildFeiyuUrl() {
        String base = endpointBase(true) + "/";
        if (!feiyuToken.isEmpty()) {
            return base + "#t=" + Uri.encode(feiyuToken);
        }
        return base;
    }

    String buildNapcatUrl() {
        return endpointBase(false) + "/webui/";
    }

    void loadBothPages() {
        try{recoverRenderer(0);recoverRenderer(1);beginPage(0);beginPage(1);webFeiyu.loadUrl(buildFeiyuUrl());bgPool.execute(new NapcatAuthWorker(this,true));}
        catch(Exception e){showConnectionError(webFeiyu,e.getMessage()==null?"请检查连接配置":e.getMessage());}
    }

    void updateStatusUi(final int state, final String badgeText) {
        mainHandler.post(new StatusUiRunner(this, state, badgeText));
    }

    void checkServerHealth(final boolean allowAutoFailover) {
        bgPool.execute(new HealthCheckWorker(this, allowAutoFailover));
    }

    void scanLanForNas(final boolean manualTrigger) {
        if (!scanning.compareAndSet(false, true)) return;
        mainHandler.post(new ScanStartUiRunner(this, manualTrigger));
        bgPool.execute(new LanScanWorker(this, manualTrigger));
    }

    boolean isPortOpen(String address,int port,int timeoutMs){
        HttpURLConnection conn=null;
        try{String base=RouteAddress.parse(address,port).base();conn=(HttpURLConnection)new URL(base+"/health").openConnection();conn.setRequestProperty("User-Agent","WhaleNest/3.6.5 (Android)");conn.setConnectTimeout(timeoutMs);conn.setReadTimeout(Math.max(3000,timeoutMs));if(conn.getResponseCode()!=200)return false;BufferedReader br=new BufferedReader(new InputStreamReader(conn.getInputStream(),StandardCharsets.UTF_8));String line=br.readLine();br.close();return line!=null&&line.contains("\"ok\":true");}
        catch(Exception e){return false;}finally{if(conn!=null)conn.disconnect();}
    }

    List<String> getLocalSubnetPrefixes() {
        List<String> list = new ArrayList<String>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                if (nif.isLoopback() || !nif.isUp()) continue;
                Enumeration<InetAddress> addrs = nif.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        String ip = addr.getHostAddress();
                        if (ip != null && (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172."))) {
                            int lastDot = ip.lastIndexOf('.');
                            if (lastDot > 0) {
                                String pref = ip.substring(0, lastDot + 1);
                                if (!list.contains(pref)) list.add(pref);
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    void showSettingsDialog() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(12), dp(20), dp(8));

        dlgInpLanHost = addField(box, "局域网 NAS 地址 (在家 Wi-Fi)", lanHost, InputType.TYPE_CLASS_TEXT);
        dlgInpLanFPort = addField(box, "局域网 肥鱼端口 (默认 3081)", String.valueOf(lanFeiyuPort), InputType.TYPE_CLASS_NUMBER);
        dlgInpLanNPort = addField(box, "局域网 NapCat端口 (默认 6099)", String.valueOf(lanNapcatPort), InputType.TYPE_CLASS_NUMBER);

        dlgInpWanHost = addField(box, "公网鲸鱼窝入口（HTTPS）", wanHost, InputType.TYPE_CLASS_TEXT);
        dlgInpWanFPort = addField(box, "公网 鲸鱼窝端口 (HTTPS 默认 443)", String.valueOf(wanFeiyuPort), InputType.TYPE_CLASS_NUMBER);
        dlgInpWanNHost=addField(box,"公网 NapCat 入口（可与鲸鱼窝不同）",wanNapcatHost,InputType.TYPE_CLASS_TEXT);
        dlgInpWanNPort = addField(box, "公网 NapCat端口 (HTTPS 默认 443)", String.valueOf(wanNapcatPort), InputType.TYPE_CLASS_NUMBER);

        dlgInpFToken = addField(box, "鲸鱼窝固定密码（不要填缩略号密钥）", feiyuToken, InputType.TYPE_CLASS_TEXT);
        dlgInpNToken = addField(box, "NapCat 登录密钥", napcatToken, InputType.TYPE_CLASS_TEXT);

        scroll.addView(box);

        SettingsDialogListener listener = new SettingsDialogListener(this);
        new AlertDialog.Builder(this)
                .setTitle("鲸鱼窝 3.6.5 · 连接配置（当前：" + (useWan ? "公网域名" : "局域网") + "）")
                .setView(scroll)
                .setPositiveButton("保存并重连", listener)
                .setNeutralButton("扫描局域网IP", listener)
                .setNegativeButton("取消", null)
                .show();
    }

    private EditText addField(LinearLayout parent, String label, String val, int inputType) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        tv.setPadding(0, dp(6), 0, dp(2));
        parent.addView(tv);

        EditText et = new EditText(this);
        et.setText(val);
        et.setInputType(inputType);
        et.setSingleLine(true);
        et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        parent.addView(et);
        return et;
    }

    int parseIntSafe(String s, int fallback) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQ) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            WebView active = activeTab == 0 ? webFeiyu : webNapcat;
            if (active != null && active.canGoBack()) {
                active.goBack();
                return true;
            }
            long now = System.currentTimeMillis();
            if (now - lastBackPress > 2000) {
                lastBackPress = now;
                Toast.makeText(this, "再按一次退出鲸鱼窝", Toast.LENGTH_SHORT).show();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        bgPool.shutdownNow();
        super.onDestroy();
    }
}

class SmartBootRouteWorker implements Runnable {
    private final MainActivity act;private final int revision;
    private final String lanHost;private final int lanPort;
    SmartBootRouteWorker(MainActivity act){this.act=act;revision=act.routeGuard.revision();lanHost=act.lanHost;lanPort=act.lanFeiyuPort;}
    @Override public void run(){
        final boolean wan=!act.isPortOpen(lanHost,lanPort,1500);
        act.mainHandler.post(new StartupRouteRunner(act,revision,wan));
    }
}

class BootLoadRunner implements Runnable {
    private final MainActivity act;
    BootLoadRunner(MainActivity act) { this.act = act; }
    @Override
    public void run() {
        act.updateRouteLabels();
        act.loadBothPages();
        act.checkServerHealth(false);
    }
}

class HealthLoopTask implements Runnable {
    private final MainActivity act;
    HealthLoopTask(MainActivity act) { this.act = act; }
    @Override
    public void run() {
        act.checkServerHealth(true);
        act.mainHandler.postDelayed(this, 12000);
    }
}

class NapcatAuthWorker implements Runnable {
    private final MainActivity act;
    private final boolean reloadAfterAuth;
    private final int revision;private final String base,token;
    NapcatAuthWorker(MainActivity act, boolean reloadAfterAuth) {
        this.act = act;
        this.reloadAfterAuth = reloadAfterAuth;
        revision=act.routeGuard.revision();base=act.endpointBase(false);token=act.napcatToken;
    }
    @Override
    public void run() {
        try {
            if(token.isEmpty())act.networkResult(1,"未配置自动登录密码，可在网页中手动登录",revision);
            if (!token.isEmpty()) {
                String hash = MainActivity.sha256Hex(token + ".napcat");
                URL url = new URL(base + "/api/auth/login");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setRequestProperty("User-Agent","WhaleNest/3.6.5 (Android)");
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(15000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                String payload = "{\"hash\":\"" + hash + "\"}";
                OutputStream os = conn.getOutputStream();
                os.write(payload.getBytes(StandardCharsets.UTF_8));
                os.close();
                int code=conn.getResponseCode();act.networkResult(1,"HTTP "+code,revision);
                if (code == 200) {
                    BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                    br.close();
                    String resp = sb.toString();
                    String marker = "\"Credential\":\"";
                    int idx = resp.indexOf(marker);
                    if (idx >= 0) {
                        int start = idx + marker.length();
                        int end = resp.indexOf("\"", start);
                        if (end > start) {
                            if(act.routeGuard.isCurrent(revision))act.napcatCredential = resp.substring(start, end);
                        }
                    }
                }
            }
        } catch (Exception error) {
            act.networkResult(1,error.getClass().getSimpleName()+" · "+error.getMessage(),revision);
        }
        if (reloadAfterAuth) {
            act.mainHandler.post(new NapcatRouteLoadRunner(act,revision));
        }
    }
}

class NapcatLoadRunner implements Runnable {
    private final MainActivity act;
    NapcatLoadRunner(MainActivity act) { this.act = act; }
    @Override
    public void run() {
        try{act.webNapcat.loadUrl(act.buildNapcatUrl());}catch(Exception e){act.showConnectionError(act.webNapcat,"NapCat 地址配置不正确，请打开连接设置");}
    }
}

class PocketWebViewClient extends WebViewClient {
    private final MainActivity act;
    private final boolean isFeiyu;
    PocketWebViewClient(MainActivity act, boolean isFeiyu) {
        this.act = act;
        this.isFeiyu = isFeiyu;
    }
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if("feiyu".equals(request.getUrl().getScheme())&&"wan-ip".equals(request.getUrl().getHost())){act.offerVerifiedWanIp();return true;}
        if("feiyu".equals(request.getUrl().getScheme())&&"settings".equals(request.getUrl().getHost())){act.showSettingsDialog();return true;}
        if(act.trustedOrigin(request.getUrl().toString(),isFeiyu))return false;
        try{act.startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl()));}catch(Exception ignored){}
        return true;
    }
    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        super.onPageStarted(view, url, favicon);act.pageStage(view,"WebView 已开始打开页面");
    }
    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        if(act.currentWeb(view)&&act.trustedOrigin(url,isFeiyu)){int index=act.webIndex(view);act.pageStage(view,"加载结束，检查页面内容");view.evaluateJavascript("Boolean(document.body && document.body.innerText.trim().length)",new PageContentCallback(act,view,act.pageStates[index].generation()));}
        if (isFeiyu) act.injectFeiyuAuth(view);
        else act.injectNapcatAuth(view);
    }
    @Override public void onPageCommitVisible(WebView view,String url){act.pageStage(view,"页面已开始绘制");}
    @Override public boolean onRenderProcessGone(WebView view,android.webkit.RenderProcessGoneDetail detail){
        if(act.currentWeb(view)){int index=act.webIndex(view);act.showConnectionError(view,"网页渲染进程退出，点击重新连接恢复");act.webContainer.removeView(view);view.destroy();if(index==0)act.webFeiyu=null;else act.webNapcat=null;act.rendererGone[index]=true;}
        return true;
    }
    @Override
    public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){
        super.onReceivedError(view,request,error);
        if(request.isForMainFrame())act.showConnectionError(view,"错误码 "+error.getErrorCode()+" · "+error.getDescription());
    }
    @Override
    public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response){
        super.onReceivedHttpError(view,request,response);
        if(request.isForMainFrame()&&response.getStatusCode()>=400)act.showConnectionError(view,"服务器返回 HTTP "+response.getStatusCode()+"，请检查是否填对鲸鱼窝或 NapCat 端口。");
    }
    @Override
    public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){
        handler.cancel();act.showConnectionError(view,"HTTPS 证书验证失败。请使用证书有效的 HTTPS 入口；若当前端口提供 HTTP，请在设置中按实际协议填写。");
    }

}

class PocketChromeClient extends WebChromeClient {
    private final MainActivity act;
    private final boolean isFeiyu;
    PocketChromeClient(MainActivity act, boolean isFeiyu) {
        this.act = act;
        this.isFeiyu = isFeiyu;
    }
    @Override
    public void onProgressChanged(WebView view, int newProgress) {
        if ((isFeiyu && act.activeTab == 0) || (!isFeiyu && act.activeTab == 1)) {
            if (newProgress < 100) {
                act.progressBar.setVisibility(View.VISIBLE);
                act.progressBar.setProgress(newProgress);
            } else {
                act.progressBar.setVisibility(View.GONE);
            }
        }
    }
    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> cb, FileChooserParams fileChooserParams) {
        if (act.filePathCallback != null) {
            act.filePathCallback.onReceiveValue(null);
        }
        act.filePathCallback = cb;
        try {
            Intent intent = fileChooserParams.createIntent();
            act.startActivityForResult(intent, MainActivity.FILE_CHOOSER_REQ);
        } catch (Exception e) {
            act.filePathCallback = null;
            return false;
        }
        return true;
    }
}

class StatusUiRunner implements Runnable {
    private final MainActivity act;
    private final int state;
    private final String labelText;
    StatusUiRunner(MainActivity act, int state, String labelText) {
        this.act = act;
        this.state = state;
        this.labelText = labelText;
    }
    @Override
    public void run() {
        int color = Color.parseColor("#F87171");
        if (state == 2) color = Color.parseColor("#4ADE80");
        else if (state == 1) color = Color.parseColor("#FBBF24");
        act.statusDot.setBackground(act.pillBg(color, 0, 4));
        if (labelText != null && !labelText.isEmpty()) {
            act.hostLabel.setText(labelText);
        }
    }
}

class HealthCheckWorker implements Runnable {
    private final MainActivity act;private final boolean allowAutoFailover,wan;
    private final int revision,port,altPort;private final String host,altHost,token,badge;
    HealthCheckWorker(MainActivity act,boolean allowAutoFailover){this.act=act;this.allowAutoFailover=allowAutoFailover;revision=act.routeGuard.revision();wan=act.useWan;host=act.activeHost();port=act.activeFeiyuPort();altHost=wan?act.lanHost:act.wanHost;altPort=wan?act.lanFeiyuPort:act.wanFeiyuPort;token=act.feiyuToken;badge=act.currentRouteBadge();}
    @Override public void run(){
        HttpURLConnection conn=null;String problem="连接未完成";
        try{
            RouteAddress address = wan ? RouteAddress.parseWan(host, port) : RouteAddress.parse(host, port);
            conn=(HttpURLConnection)new URL(address.base()+"/api/auth/check").openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent","WhaleNest/3.6.5 (Android)");
            conn.setConnectTimeout(wan?10000:3000);conn.setReadTimeout(wan?15000:5000);
            if(!token.isEmpty())conn.setRequestProperty("x-web-token",token);
            int code=conn.getResponseCode();
            if(code==200){act.networkResult(0,"HTTP 200，服务器已响应",revision);act.routeStatus(2,badge,revision);return;}
            if(code==401){act.networkResult(0,"HTTP 401，需在设置填写固定密码",revision);act.routeStatus(1,"密码不正确 · 打开设置",revision);return;}
            problem="HTTP "+code;
        }catch(java.net.UnknownHostException e){problem="域名解析失败 · "+e.getMessage();}
         catch(java.net.SocketTimeoutException e){problem="连接超时 · "+e.getMessage();}
         catch(javax.net.ssl.SSLException e){problem="HTTPS 错误 · "+e.getMessage();}
         catch(Exception e){problem=e.getClass().getSimpleName()+" · "+e.getMessage();}
        finally{if(conn!=null)conn.disconnect();}
        if(!act.routeGuard.isCurrent(revision))return;
        act.networkResult(0,problem,revision);
        if(allowAutoFailover&&!act.routeGuard.isManual()&&act.isPortOpen(altHost,altPort,6000)){
            act.mainHandler.post(new AutoRouteSwitchRunner(act,revision,!wan));return;
        }
        act.routeStatus(0,(wan?"公网":"内网")+" · "+problem,revision);
    }
}


class ScanStartUiRunner implements Runnable {
    private final MainActivity act;
    private final boolean manualTrigger;
    ScanStartUiRunner(MainActivity act, boolean manualTrigger) {
        this.act = act;
        this.manualTrigger = manualTrigger;
    }
    @Override
    public void run() {
        if (manualTrigger) {
            Toast.makeText(act, "正在扫描局域网 NAS…", Toast.LENGTH_SHORT).show();
        }
    }
}

class PortProbeTask implements Callable<String> {
    private final MainActivity act;
    private final String ip;
    PortProbeTask(MainActivity act, String ip) {
        this.act = act;
        this.ip = ip;
    }
    @Override
    public String call() {
        return act.isPortOpen(ip, act.lanFeiyuPort, 320) ? ip : null;
    }
}

class ScanFinishUiRunner implements Runnable {
    private final MainActivity act;
    private final String resultIp;
    private final boolean manualTrigger;
    ScanFinishUiRunner(MainActivity act, String resultIp, boolean manualTrigger) {
        this.act = act;
        this.resultIp = resultIp;
        this.manualTrigger = manualTrigger;
    }
    @Override
    public void run() {
        if (resultIp != null) {
            act.saveAllConfig(false, resultIp, act.lanFeiyuPort, act.lanNapcatPort,
                    act.wanHost, act.wanFeiyuPort, act.wanNapcatPort, act.feiyuToken, act.napcatToken);
            act.loadBothPages();
            Toast.makeText(act, "已定位局域网 NAS: " + resultIp, Toast.LENGTH_SHORT).show();
            act.checkServerHealth(false);
        } else if (manualTrigger) {
            Toast.makeText(act, "未扫到局域网 NAS，已切至公网 VPS 线路", Toast.LENGTH_SHORT).show();
            act.setUseWanMode(true);
            act.loadBothPages();
            act.checkServerHealth(false);
        }
    }
}

class LanScanWorker implements Runnable {
    private final MainActivity act;
    private final int revision;
    private final boolean manualTrigger;
    LanScanWorker(MainActivity act, boolean manualTrigger) {
        this.act = act;
        revision=act.routeGuard.revision();
        this.manualTrigger = manualTrigger;
    }
    @Override
    public void run() {
        String foundIp = null;
        try {
            {
                List<String> prefixes = act.getLocalSubnetPrefixes();
                ExecutorService scanPool = Executors.newFixedThreadPool(48);
                List<Future<String>> futures = new ArrayList<Future<String>>();
                for (String prefix : prefixes) {
                    for (int i = 1; i <= 254; i++) {
                        futures.add(scanPool.submit(new PortProbeTask(act, prefix + i)));
                    }
                }
                scanPool.shutdown();
                for (Future<String> f : futures) {
                    try {
                        String r = f.get();
                        if (r != null) {
                            foundIp = r;
                            break;
                        }
                    } catch (Exception ignored) {
                    }
                }
                scanPool.shutdownNow();
            }
        } finally {
            act.scanning.set(false);
        }
        act.mainHandler.post(new GuardedScanFinishRunner(act,foundIp,manualTrigger,revision));
    }
}

class SettingsDialogListener implements DialogInterface.OnClickListener {
    private final MainActivity act;
    SettingsDialogListener(MainActivity act) { this.act = act; }
    @Override
    public void onClick(DialogInterface dialog, int which) {
        if (which == DialogInterface.BUTTON_POSITIVE) {
            int lfp = act.parseIntSafe(act.dlgInpLanFPort.getText().toString(), MainActivity.DEFAULT_LAN_FEIYU_PORT);
            int lnp = act.parseIntSafe(act.dlgInpLanNPort.getText().toString(), MainActivity.DEFAULT_LAN_NAPCAT_PORT);
            int wfp = act.parseIntSafe(act.dlgInpWanFPort.getText().toString(), MainActivity.DEFAULT_WAN_FEIYU_PORT);
            int wnp = act.parseIntSafe(act.dlgInpWanNPort.getText().toString(), MainActivity.DEFAULT_WAN_NAPCAT_PORT);
            try{
            act.saveAllConfig(
                    act.useWan,
                    act.dlgInpLanHost.getText().toString(), lfp, lnp,
                    act.dlgInpWanHost.getText().toString(), wfp, wnp,
                    act.dlgInpFToken.getText().toString(),
                    act.dlgInpNToken.getText().toString(),act.dlgInpWanNHost.getText().toString()
            );
            }catch(IllegalArgumentException error){Toast.makeText(act,error.getMessage(),Toast.LENGTH_LONG).show();act.showSettingsDialog();return;}
            act.loadBothPages();
            act.checkServerHealth(false);
            Toast.makeText(act, "配置已保存", Toast.LENGTH_SHORT).show();
        } else if (which == DialogInterface.BUTTON_NEUTRAL) {
            act.scanLanForNas(true);
        }
    }
}

class RouteStatusRunner implements Runnable {
    final MainActivity act;final int state,revision;final String label;
    RouteStatusRunner(MainActivity act,int state,String label,int revision){this.act=act;this.state=state;this.label=label;this.revision=revision;}
    @Override public void run(){if(act.routeGuard.isCurrent(revision))new StatusUiRunner(act,state,label).run();}
}
class StartupRouteRunner implements Runnable {
    final MainActivity act;final int revision;final boolean wan;
    StartupRouteRunner(MainActivity act,int revision,boolean wan){this.act=act;this.revision=revision;this.wan=wan;}
    @Override public void run(){if(!act.routeGuard.acceptAutomatic(revision))return;act.useWan=wan;new BootLoadRunner(act).run();}
}
class NapcatRouteLoadRunner implements Runnable {
    final MainActivity act;final int revision;
    NapcatRouteLoadRunner(MainActivity act,int revision){this.act=act;this.revision=revision;}
    @Override public void run(){if(act.routeGuard.isCurrent(revision))new NapcatLoadRunner(act).run();}
}
class AutoRouteSwitchRunner implements Runnable {
    final MainActivity act;final int revision;final boolean wan;
    AutoRouteSwitchRunner(MainActivity act,int revision,boolean wan){this.act=act;this.revision=revision;this.wan=wan;}
    @Override public void run(){if(!act.routeGuard.acceptAutomatic(revision))return;act.useWan=wan;act.napcatCredential="";act.updateRouteLabels();act.loadBothPages();act.checkServerHealth(false);}
}

class GuardedScanFinishRunner implements Runnable {
    final MainActivity act;final String ip;final boolean manual;final int revision;
    GuardedScanFinishRunner(MainActivity act,String ip,boolean manual,int revision){this.act=act;this.ip=ip;this.manual=manual;this.revision=revision;}
    @Override public void run(){if(act.routeGuard.isCurrent(revision))new ScanFinishUiRunner(act,ip,manual).run();}
}

class NativeNetworkRunner implements Runnable {
    final MainActivity act;final int index,revision;final String text;
    NativeNetworkRunner(MainActivity act,int index,String text,int revision){this.act=act;this.index=index;this.text=text;this.revision=revision;}
    @Override public void run(){if(act.routeGuard.isCurrent(revision)){act.pageStates[index].network=text;act.refreshConnectionInfo();}}
}
class PageWatchdog implements Runnable {
    final MainActivity act;final int index,generation;
    PageWatchdog(MainActivity act,int index,int generation){this.act=act;this.index=index;this.generation=generation;}
    @Override public void run(){PageLoadState state=act.pageStates[index];if(state.waiting(generation)){state.stage("等待已超过 25 秒；可点诊断查看连接结果，或用浏览器继续");act.refreshConnectionInfo();}}
}
class PageContentCallback implements ValueCallback {
    final MainActivity act;final WebView view;final int generation,attempt;
    PageContentCallback(MainActivity act,WebView view,int generation){this(act,view,generation,0);}
    PageContentCallback(MainActivity act,WebView view,int generation,int attempt){this.act=act;this.view=view;this.generation=generation;this.attempt=attempt;}
    @Override public void onReceiveValue(Object value){if(!act.currentWeb(view))return;PageLoadState state=act.pageStates[act.webIndex(view)];boolean accepted=state.content(generation,"true".equals(value));act.refreshConnectionInfo();if(accepted&&!state.ready&&attempt<20)act.mainHandler.postDelayed(new PageContentProbe(act,view,generation,attempt+1),1000);}

}

class PageContentProbe implements Runnable {
    final MainActivity act;final WebView view;final int generation,attempt;
    PageContentProbe(MainActivity act,WebView view,int generation,int attempt){this.act=act;this.view=view;this.generation=generation;this.attempt=attempt;}
    @Override public void run(){if(act.currentWeb(view)&&act.pageStates[act.webIndex(view)].waiting(generation))view.evaluateJavascript("Boolean(document.body && document.body.innerText.trim().length)",new PageContentCallback(act,view,generation,attempt));}
}
