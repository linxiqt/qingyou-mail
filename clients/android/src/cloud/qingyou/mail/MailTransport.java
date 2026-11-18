package cloud.qingyou.mail;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import javax.net.ssl.*;

final class MailTransport {
  static String server(String input) throws Exception {
    URI uri = new URI(input.trim());
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
        (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/")))
      throw new IllegalArgumentException("服务器地址必须为 HTTPS 域名或 IP，可包含端口");
    return new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), uri.getPort(), null, null, null).toASCIIString();
  }
  static String path(String input) {
    String path = input.toLowerCase(Locale.ROOT);
    if (!path.matches("^/(mailbox|messages|attachments|send|drafts|templates|auth/me|auth/logout|manage)([/?].*)?$") ||
        path.contains("..") || path.contains("\\") || path.contains("%2e") || path.contains("%2f") || path.contains("%5c") || path.contains("#") || path.contains("\r") || path.contains("\n"))
      throw new IllegalArgumentException("不允许访问该客户端接口");
    return input;
  }
  static String fingerprint(X509Certificate certificate) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
    StringBuilder out = new StringBuilder();
    for (byte b : digest) { if (out.length() > 0) out.append(':'); out.append(String.format(Locale.ROOT, "%02X", b & 255)); }
    return out.toString();
  }
  static X509TrustManager defaultTrust() throws Exception {
    TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); factory.init((KeyStore) null);
    for (TrustManager manager : factory.getTrustManagers()) if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
    throw new CertificateException("系统 TLS 信任管理器不可用");
  }
  static SSLSocketFactory pinnedFactory(final String pin) throws Exception {
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, new TrustManager[]{new X509TrustManager() {
      public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
      public void checkClientTrusted(X509Certificate[] c, String a) throws CertificateException { throw new CertificateException("Client certificates unsupported"); }
      public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
        try { if (chain.length == 0) throw new CertificateException("Missing certificate"); chain[0].checkValidity();
          if (!MessageDigest.isEqual(fingerprint(chain[0]).getBytes("UTF-8"), pin.getBytes("UTF-8"))) throw new CertificateException("服务器证书指纹已变化");
        } catch (Exception error) { throw new CertificateException(error); }
      }
    }}, null); return context.getSocketFactory();
  }
  static JSONObject inspect(String origin) throws Exception {
    final X509Certificate[][] observed = new X509Certificate[1][];
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, new TrustManager[]{new X509TrustManager() {
      public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
      public void checkClientTrusted(X509Certificate[] c, String a) throws CertificateException { throw new CertificateException(); }
      public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException { observed[0] = chain; }
    }}, null);
    URL url = new URL(origin);
    try (Socket tcp = new Socket()) {
      tcp.connect(new InetSocketAddress(url.getHost(), url.getPort() < 0 ? 443 : url.getPort()), 10000); tcp.setSoTimeout(10000);
      try (SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(tcp, url.getHost(), url.getPort() < 0 ? 443 : url.getPort(), false)) {
        socket.setSoTimeout(10000); socket.startHandshake();
        if (observed[0] == null || observed[0].length == 0) throw new CertificateException("服务器没有提供证书");
        X509Certificate cert = observed[0][0]; boolean trusted = false;
        try { defaultTrust().checkServerTrusted(observed[0], cert.getPublicKey().getAlgorithm());
          trusted = HttpsURLConnection.getDefaultHostnameVerifier().verify(url.getHost(), socket.getSession());
        } catch (CertificateException ignored) { }
        return new JSONObject().put("server", origin).put("fingerprint", fingerprint(cert)).put("subject", cert.getSubjectX500Principal().getName())
          .put("issuer", cert.getIssuerX500Principal().getName()).put("validFrom", cert.getNotBefore().toString()).put("validTo", cert.getNotAfter().toString()).put("trusted", trusted);
      }
    }
  }
  static final class Response {
    int status; byte[] bytes; String type; Map<String,List<String>> headers;
    JSONObject json() throws Exception { return bytes.length == 0 ? new JSONObject() : new JSONObject(new String(bytes, "UTF-8")); }
  }
  static Response fetch(JSONObject account, String apiPath, String method, Object body, String pin) throws Exception {
    String origin = server(account.getString("server"));
    HttpsURLConnection connection = (HttpsURLConnection) new URL(origin + apiPath).openConnection();
    connection.setConnectTimeout(15000); connection.setReadTimeout(45000); connection.setInstanceFollowRedirects(false);
    if (!pin.isEmpty()) connection.setSSLSocketFactory(pinnedFactory(pin)); // Hostname verification stays enabled.
    connection.setRequestMethod(method); connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("Origin", origin);
    connection.setRequestProperty("X-CSRF-Token", account.optString("csrf"));
    String cookie = account.optString("cookie"); if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
    boolean startedMutation = false;
    try {
      if (body != null && body != JSONObject.NULL && !method.equals("GET") && !method.equals("HEAD")) {
        byte[] bytes = body.toString().getBytes("UTF-8"); if (bytes.length > 28*1024*1024) throw new IOException("请求过大");
        connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = connection.getOutputStream()) { startedMutation = true; out.write(bytes); }
      }
      startedMutation |= !method.equals("GET") && !method.equals("HEAD");
      Response response = new Response(); response.status = connection.getResponseCode(); response.type = connection.getContentType(); response.headers = connection.getHeaderFields();
      if (response.status >= 300 && response.status < 400) throw new IOException("服务器发生重定向，请填写最终 HTTPS 地址");
      for (Map.Entry<String,List<String>> header : response.headers.entrySet()) {
        if ("set-cookie".equalsIgnoreCase(header.getKey())) for (String value : header.getValue()) {
          String pair = value.split(";", 2)[0];
          if (pair.startsWith("postoffice_client_session=")) account.put("cookie", pair);
        }
      }
      try (InputStream input = response.status >= 400 ? connection.getErrorStream() : connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        if (input != null) { byte[] buffer = new byte[16384]; int count; while ((count=input.read(buffer)) >= 0) { if (out.size() + count > 32*1024*1024) throw new IOException("服务器响应过大"); out.write(buffer,0,count); } }
        response.bytes = out.toByteArray();
      }
      long expectedLength = connection.getContentLengthLong();
      if (expectedLength >= 0 && response.bytes.length != expectedLength)
        throw new IOException("服务器响应未完整接收");
      return response;
    } catch (IOException error) {
      if (startedMutation && !(error instanceof SSLException))
        throw new IOException("请求结果尚未确认，请刷新服务器数据核对，避免重复发送。", error);
      throw error;
    } finally { connection.disconnect(); }
  }
}
