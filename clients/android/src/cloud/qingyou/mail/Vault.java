package cloud.qingyou.mail;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only account metadata, CSRF tokens and isolated cookies are persisted. Never passwords/mail. */
final class Vault {
  private final Context context;
  private static final String ALIAS = "qingyou.client.sessions.v1";
  Vault(Context context) { this.context = context; }
  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    if (!store.containsAlias(ALIAS)) {
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
      generator.generateKey();
    }
    return (SecretKey) store.getKey(ALIAS, null);
  }
  synchronized JSONObject read() throws Exception {
    String stored = context.getSharedPreferences("encrypted_sessions", Context.MODE_PRIVATE).getString("vault", "");
    if (stored.isEmpty()) return new JSONObject();
    JSONObject envelope = new JSONObject(stored);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), "UTF-8"));
  }
  synchronized void write(JSONObject value) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
    JSONObject envelope = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
      .put("data", Base64.encodeToString(cipher.doFinal(value.toString().getBytes("UTF-8")), Base64.NO_WRAP));
    if (!context.getSharedPreferences("encrypted_sessions", Context.MODE_PRIVATE).edit().putString("vault", envelope.toString()).commit())
      throw new IllegalStateException("无法保存加密登录状态");
  }
}
