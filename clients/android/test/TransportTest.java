package cloud.qingyou.mail;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;
import javax.net.ssl.*;
import com.sun.net.httpserver.*;

public final class TransportTest {
  static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
  interface Checked { void run() throws Exception; }
  static void rejects(Checked op,String label)throws Exception{try{op.run();}catch(Exception expected){return;}throw new AssertionError(label);}
  public static void main(String[] args)throws Exception{
    check(MailTransport.server("https://EXAMPLE.com:24785/").equals("https://example.com:24785"),"server canonicalization");
    for(String value:new String[]{"http://example.com","https://user:pass@example.com","https://example.com/path","https://example.com?x=1","file:///tmp/data"})rejects(()->MailTransport.server(value),"unsafe origin");
    for(String value:new String[]{"https://example.com","//evil.example/a","/messages/../../admin","/messages/%2e%2e/admin","/messages/%2fadmin","/admin/managers","/auth/login","/messages#x"})rejects(()->MailTransport.path(value),"unsafe path "+value);
    check(MailTransport.path("/messages?folder=inbox&page=2").contains("page=2"),"query preserved");
    KeyStore keyStore=KeyStore.getInstance("PKCS12");try(InputStream in=new FileInputStream(args[0])){keyStore.load(in,"android".toCharArray());}
    KeyManagerFactory kmf=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());kmf.init(keyStore,"android".toCharArray());
    SSLContext tls=SSLContext.getInstance("TLS");tls.init(kmf.getKeyManagers(),null,null);
    HttpsServer server=HttpsServer.create(new InetSocketAddress("127.0.0.1",0),0);server.setHttpsConfigurator(new HttpsConfigurator(tls));
    server.createContext("/login",exchange->{
      byte[] body=exchange.getRequestBody().readAllBytes();String who=new String(body,"UTF-8").contains("alice")?"alice":"bob";
      exchange.getResponseHeaders().set("Set-Cookie","postoffice_client_session="+who+"; HttpOnly; Secure; Path=/");
      byte[] reply="{\"ok\":true}".getBytes("UTF-8");exchange.sendResponseHeaders(200,reply.length);exchange.getResponseBody().write(reply);exchange.close();
    });
    server.createContext("/who",exchange->{
      String cookie=exchange.getRequestHeaders().getFirst("Cookie");
      byte[] reply=new JSONObject().put("cookie",cookie).put("csrf",exchange.getRequestHeaders().getFirst("X-CSRF-Token")).toString().getBytes("UTF-8");
      exchange.sendResponseHeaders(200,reply.length);exchange.getResponseBody().write(reply);exchange.close();
    });
    server.createContext("/redirect",exchange->{exchange.getResponseHeaders().set("Location","https://example.com");exchange.sendResponseHeaders(302,-1);exchange.close();});
    server.createContext("/broken",exchange->{exchange.getRequestBody().readAllBytes();exchange.sendResponseHeaders(200,100);exchange.getResponseBody().write("{\"ok\":".getBytes("UTF-8"));exchange.close();});
    server.start();
    try{
      String origin="https://localhost:"+server.getAddress().getPort();String pin=MailTransport.fingerprint((X509Certificate)keyStore.getCertificate("fixture"));
      JSONObject alice=new JSONObject().put("server",origin).put("csrf","csrf-a");JSONObject bob=new JSONObject().put("server",origin).put("csrf","csrf-b");
      rejects(()->MailTransport.fetch(alice,"/login","POST",new JSONObject(),""),"selfsigned must reject before trust");
      JSONObject certificate=MailTransport.inspect(origin);check(certificate.getString("fingerprint").equals(pin),"inspection fingerprint");check(!certificate.getBoolean("trusted"),"inspection never silently trusts");
      MailTransport.fetch(alice,"/login","POST",new JSONObject().put("username","alice"),pin);MailTransport.fetch(bob,"/login","POST",new JSONObject().put("username","bob"),pin);
      JSONObject a=MailTransport.fetch(alice,"/who","GET",null,pin).json();JSONObject b=MailTransport.fetch(bob,"/who","GET",null,pin).json();
      check(a.getString("cookie").equals("postoffice_client_session=alice"),"alice session isolated");check(b.getString("cookie").equals("postoffice_client_session=bob"),"bob session isolated");
      check(a.getString("csrf").equals("csrf-a") && b.getString("csrf").equals("csrf-b"),"CSRF isolation");
      rejects(()->MailTransport.fetch(alice,"/who","GET",null,pin.replace(':','0')),"changed pin must reject");
      JSONObject wrongHost=new JSONObject().put("server",origin.replace("localhost","127.0.0.1"));
      rejects(()->MailTransport.fetch(wrongHost,"/who","GET",null,pin),"hostname verification survives pinning");
      rejects(()->MailTransport.fetch(alice,"/redirect","GET",null,pin),"redirect must not follow with secrets");
      try {MailTransport.fetch(alice,"/broken","POST",new JSONObject(),pin);throw new AssertionError("truncated write response must be uncertain");}
      catch(IOException expected){check(expected.getMessage().contains("结果尚未确认"),"ambiguous mutations must not invite retries");}
      System.out.println("PASS: origin/path validation, isolated cookies+CSRF, cert inspection/pinning, hostname checking, redirect rejection");
    }finally{server.stop(0);}
  }
}
