package cloud.qingyou.mail;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.view.View;
import android.graphics.Color;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
  private static final String ORIGIN = "https://app.qingyou.local";
  private WebView web;
  private Vault vault;
  private JSONObject state;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private ValueCallback<Uri[]> fileChoice;
  private String downloadId;
  private byte[] downloadBytes;
  private boolean destroyed;
  private boolean backPending;
  private final Set<String> cancelled=ConcurrentHashMap.newKeySet();

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    try { vault = new Vault(this); state = vault.read(); if (!state.has("accounts")) state.put("accounts", new JSONArray()); if (!state.has("pins")) state.put("pins", new JSONObject()); }
    catch (Exception error) { new AlertDialog.Builder(this).setTitle("无法读取登录信息").setMessage("本机加密存储不可用，请检查设备解锁状态后重启应用。不会自动清除已有账户。").setPositiveButton("关闭", (d,w)->finish()).setCancelable(false).show(); return; }
    boolean dark=(getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)==android.content.res.Configuration.UI_MODE_NIGHT_YES;
    int background=dark?Color.rgb(25,30,45):Color.rgb(240,242,251);
    getWindow().setStatusBarColor(background); getWindow().setNavigationBarColor(background);
    getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(background));
    getWindow().getDecorView().setSystemUiVisibility(dark?0:View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    web = new WebView(this); setContentView(web);
    web.setBackgroundColor(background);
    web.setOnApplyWindowInsetsListener((v,insets)-> { v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets.consumeSystemWindowInsets(); });
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true);
    web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
    web.getSettings().setAllowFileAccessFromFileURLs(false); web.getSettings().setAllowUniversalAccessFromFileURLs(false);
    web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.getSettings().setMediaPlaybackRequiresUserGesture(true);
    web.getSettings().setJavaScriptCanOpenWindowsAutomatically(false); web.getSettings().setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptCookie(false); CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
    web.addJavascriptInterface(new Bridge(), "AndroidBridge");
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !isLocal(request.getUrl()); }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!isLocal(request.getUrl())) return response("text/plain",403,"Blocked",new ByteArrayInputStream(new byte[0]));
        String path = request.getUrl().getPath(); if (path == null || path.equals("/")) path="/index.html";
        if (path.contains("..") || path.contains("\\")) return response("text/plain",403,"Blocked",new ByteArrayInputStream(new byte[0]));
        try { String type = path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".png") ? "image/png" : "text/html";
          return response(type,200,"OK",getAssets().open("ui"+path));
        } catch (IOException error) { return response("text/plain",404,"Not Found",new ByteArrayInputStream(new byte[0])); }
      }
      @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileChoice != null) fileChoice.onReceiveValue(null); fileChoice = callback;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
        startActivityForResult(intent, 201); return true;
      }
    });
    web.loadUrl(ORIGIN+"/index.html");
    if(android.os.Build.VERSION.SDK_INT>=33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,this::handleBack);
    }
  }
  private boolean isLocal(Uri uri) { return "https".equals(uri.getScheme()) && "app.qingyou.local".equals(uri.getHost()) && uri.getPort()==-1; }
  private WebResourceResponse response(String type,int status,String reason,InputStream data) {
    Map<String,String> headers = new HashMap<>();
    headers.put("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
    headers.put("X-Content-Type-Options","nosniff"); headers.put("Cache-Control","no-cache");
    return new WebResourceResponse(type,"UTF-8",status,reason,headers,data);
  }
  private JSONArray accounts() throws Exception { return state.getJSONArray("accounts"); }
  private JSONObject account(String id) throws Exception {
    JSONArray all=accounts(); for(int i=0;i<all.length();i++){JSONObject a=all.getJSONObject(i);if(a.getString("id").equals(id))return a;}
    throw new IllegalArgumentException("账号不存在或已经退出");
  }
  private String pin(String server) throws Exception { return state.getJSONObject("pins").optString(server); }
  private JSONObject publicAccount(JSONObject account) throws Exception {
    return new JSONObject().put("id",account.getString("id")).put("server",account.getString("server")).put("user",account.getJSONObject("user")).put("portal","client");
  }
  private void reply(String id,Object value,Exception error) {
    if(destroyed) return;
    try {
      JSONObject result=new JSONObject();
      if(error==null) result.put("value",value==null?JSONObject.NULL:value);
      else { String message=error.getMessage(); Throwable cause=error;
        boolean tls=false; while(cause!=null){if(cause instanceof javax.net.ssl.SSLException || cause instanceof java.security.cert.CertificateException)tls=true;cause=cause.getCause();}
        result.put("error",tls?"服务器证书未受信任或已变化。请核对证书后再连接。":message==null?"操作失败，请重试":message);
        result.put("code",tls?"TLS_UNTRUSTED":"CLIENT_ERROR");
      }
      final String script="window.__postofficeNativeResult("+JSONObject.quote(id)+","+result.toString().replace("\u2028","\\u2028").replace("\u2029","\\u2029")+")";
      runOnUiThread(()->{if(!destroyed && web!=null)web.evaluateJavascript(script,null);});
    } catch(Exception ignored) { }
  }
  private final class Bridge {
    @JavascriptInterface public void cancel(String id) { if(id!=null && id.matches("[0-9]{1,12}"))cancelled.add(id); }
    @JavascriptInterface public void call(String id,String method,String payload,long deadline) {
      if(id==null || !id.matches("[0-9]{1,12}") || payload==null || payload.length()>38*1024*1024)return;
      worker.execute(()->{
        try {
          if(cancelled.remove(id) || System.currentTimeMillis()>=deadline)throw new IOException("请求已取消，未开始执行");
          Object result=dispatch(id,method,new JSONObject(payload)); if(result!=Deferred.INSTANCE)reply(id,result,null);
        }
        catch(Exception error){reply(id,null,error);}
        finally{cancelled.remove(id);}
      });
    }
  }
  private enum Deferred { INSTANCE }
  private Object dispatch(String id,String method,JSONObject input) throws Exception {
    switch(method){
      case "listAccounts": {
        JSONArray list=new JSONArray(); for(int i=0;i<accounts().length();i++)list.put(publicAccount(accounts().getJSONObject(i))); return list;
      }
      case "login": {
        String server=MailTransport.server(input.getString("server"));
        String username=input.getString("username").trim();
        if(!username.contains("@"))throw new IllegalArgumentException("Android 客户端请使用完整邮箱地址。管理员 admin 请使用 Windows 客户端。");
        boolean existing=false;
        for(int i=0;i<accounts().length();i++){
          JSONObject a=accounts().getJSONObject(i);
          if(a.getString("server").equals(server) && a.getJSONObject("user").optString("email").equalsIgnoreCase(username))existing=true;
        }
        if(!existing && accounts().length()>=20)throw new IllegalArgumentException("最多保存 20 个账号，请先退出不再使用的账号");
        JSONObject candidate=new JSONObject().put("id",UUID.randomUUID().toString()).put("server",server).put("portal","client");
        JSONObject credentials=new JSONObject().put("email",username).put("password",input.getString("password"));
        MailTransport.Response response=MailTransport.fetch(candidate,"/api/client/auth/login","POST",credentials,pin(server));
        credentials.remove("password"); input.remove("password");
        JSONObject body=response.json(); if(response.status!=200)throw new IOException(body.optString("error","登录失败"));
        candidate.put("user",body.getJSONObject("user")).put("csrf",body.getString("csrfToken"));
        if(candidate.optString("cookie").isEmpty())throw new IOException("服务器未返回独立客户端会话");
        JSONArray all=accounts(); boolean replaced=false;
        for(int i=0;i<all.length();i++){JSONObject old=all.getJSONObject(i);
          if(old.getString("server").equals(server) && old.getJSONObject("user").getInt("id")==candidate.getJSONObject("user").getInt("id")){
            candidate.put("id",old.getString("id")); all.put(i,candidate); replaced=true;break;
          }
        }
        if(!replaced)all.put(candidate); vault.write(state); return publicAccount(candidate);
      }
      case "request": {
        JSONObject a=account(input.getString("accountId")); String path=MailTransport.path(input.getString("path"));
        String verb=input.optString("method","GET").toUpperCase(Locale.ROOT);
        if(!Arrays.asList("GET","POST","PATCH","PUT","DELETE").contains(verb))throw new IllegalArgumentException("请求方法无效");
        if(path.startsWith("/auth/logout"))throw new IllegalArgumentException("请使用退出账号功能");
        if(ServerLicense.requires(path)) {
          MailTransport.Response check=MailTransport.fetch(a,"/api/client/auth/me","GET",null,pin(a.getString("server")));
          JSONObject verified=check.json();
          if(check.status!=200)return new JSONObject().put("status",check.status).put("data",verified);
          if(verified.has("csrfToken"))a.put("csrf",verified.getString("csrfToken"));
          vault.write(state);
          if(!ServerLicense.valid(verified,System.currentTimeMillis()))return new JSONObject().put("status",402).put("data",new JSONObject().put("code","LICENSE_REQUIRED").put("error","服务端授权未生效，发件和管理暂不可用，请联系管理员恢复授权。"));
        }
        MailTransport.Response r=MailTransport.fetch(a,"/api/client"+path,verb,input.opt("body"),pin(a.getString("server")));
        JSONObject body;
        try { body=r.json(); }
        catch(Exception parseError){throw new IOException(verb.equals("GET")?"服务器返回的内容无效":"请求结果尚未确认，请刷新服务器数据核对，避免重复发送。",parseError);}
        if(body.has("csrfToken"))a.put("csrf",body.getString("csrfToken"));
        if(path.equals("/auth/me") && r.status==200)a.put("user",body.getJSONObject("user"));
        vault.write(state); return new JSONObject().put("status",r.status).put("data",body);
      }
      case "removeAccount": {
        JSONObject a=account(input.getString("id")); boolean revoked=false;
        try{ revoked=MailTransport.fetch(a,"/api/client/auth/logout","POST",new JSONObject(),pin(a.getString("server"))).status==200; }catch(Exception ignored){}
        JSONArray updated=new JSONArray();for(int i=0;i<accounts().length();i++){JSONObject item=accounts().getJSONObject(i);if(!item.getString("id").equals(a.getString("id")))updated.put(item);}
        state.put("accounts",updated);vault.write(state);return new JSONObject().put("ok",true).put("serverLoggedOut",revoked);
      }
      case "inspectCertificate": return MailTransport.inspect(MailTransport.server(input.getString("server")));
      case "trustCertificate": {
        String server=MailTransport.server(input.getString("server")); JSONObject observed=MailTransport.inspect(server);
        String fingerprint=input.getString("fingerprint").toUpperCase(Locale.ROOT);
        if(!fingerprint.equals(observed.getString("fingerprint")))throw new IOException("服务器证书已变化，请重新核对");
        CompletableFuture<Boolean> choice=new CompletableFuture<>();
        runOnUiThread(()->new AlertDialog.Builder(this).setTitle("核对服务器证书")
          .setMessage(server+"\n\nSHA-256\n"+fingerprint+"\n\n请与服务器管理员通过可信渠道核对。确认后仅信任此服务器的这一张证书；证书变化会阻止连接。")
          .setPositiveButton("指纹一致，信任",(d,w)->choice.complete(true)).setNegativeButton("取消",(d,w)->choice.complete(false)).setOnCancelListener(d->choice.complete(false)).show());
        if(!choice.get(70,TimeUnit.SECONDS))throw new IOException("已取消证书信任");
        state.getJSONObject("pins").put(server,fingerprint);vault.write(state);return new JSONObject().put("ok",true);
      }
      case "copyText": {
        Object value=input.opt("text");
        if(!(value instanceof String) || ((String)value).isEmpty() || ((String)value).length()>1000000)throw new IllegalArgumentException("复制内容无效或过长");
        CompletableFuture<Boolean> copied=new CompletableFuture<>();
        runOnUiThread(()->{
          try {
            android.content.ClipboardManager manager=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
            if(manager==null)throw new IllegalStateException("剪贴板不可用");
            manager.setPrimaryClip(android.content.ClipData.newPlainText("青邮接口文档",(String)value));
            copied.complete(true);
          } catch(Exception error){copied.completeExceptionally(error);}
        });
        return new JSONObject().put("copied",copied.get(10,TimeUnit.SECONDS));
      }
      case "download": {
        JSONObject a=account(input.getString("accountId"));String path=MailTransport.path(input.getString("path"));
        if(!path.matches("^/(attachments/[0-9]+|messages/[0-9]+/raw)$"))throw new IllegalArgumentException("下载地址无效");
        MailTransport.Response response=MailTransport.fetch(a,"/api/client"+path,"GET",null,pin(a.getString("server")));
        if(response.status!=200)throw new IOException("附件下载失败："+response.status);
        if(downloadId!=null)throw new IOException("请先完成当前文件保存");
        downloadId=id;downloadBytes=response.bytes;
        String filename=input.optString("filename","attachment").replaceAll("[\\\\/\r\n]","_");
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,filename);
        runOnUiThread(()->startActivityForResult(intent,202));return Deferred.INSTANCE;
      }
      default: throw new IllegalArgumentException("客户端不支持此功能");
    }
  }
  @Override protected void onActivityResult(int request,int result,Intent data){
    super.onActivityResult(request,result,data);
    if(request==201 && fileChoice!=null){
      ArrayList<Uri> uris=new ArrayList<>();if(result==RESULT_OK && data!=null){if(data.getClipData()!=null){for(int i=0;i<data.getClipData().getItemCount();i++)uris.add(data.getClipData().getItemAt(i).getUri());}else if(data.getData()!=null)uris.add(data.getData());}
      fileChoice.onReceiveValue(uris.isEmpty()?null:uris.toArray(new Uri[0]));fileChoice=null;
    }
    if(request==202 && downloadId!=null){
      final String id=downloadId;final byte[] bytes=downloadBytes;downloadId=null;downloadBytes=null;
      if(result!=RESULT_OK || data==null || data.getData()==null){try{reply(id,new JSONObject().put("saved",false).put("cancelled",true),null);}catch(Exception ignored){}return;}
      final Uri uri=data.getData();worker.execute(()->{try(OutputStream out=getContentResolver().openOutputStream(uri)){if(out==null)throw new IOException("无法打开所选文件");out.write(bytes);reply(id,new JSONObject().put("saved",true).put("cancelled",false),null);}catch(Exception error){reply(id,null,error);}});
    }
  }
  private void handleBack(){
    if(destroyed || backPending)return;
    if(web==null){moveTaskToBack(true);return;}
    backPending=true;
    web.evaluateJavascript("Boolean(window.__postofficeBack && window.__postofficeBack())",handled->{
      backPending=false;
      if(destroyed || "true".equals(handled))return;
      if(web!=null && web.canGoBack())web.goBack();else moveTaskToBack(true);
    });
  }
  @Override public void onBackPressed(){handleBack();}
  @Override protected void onDestroy(){destroyed=true;if(web!=null){web.removeJavascriptInterface("AndroidBridge");web.destroy();}worker.shutdownNow();super.onDestroy();}
}
