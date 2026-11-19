package com.dsh.feiyu;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class TokenVault {
    private static final String ALIAS = "whalenest-web-credentials";
    private static final String CIPHER = "AES/GCM/NoPadding";

    private static synchronized SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey saved = (SecretKey) store.getKey(ALIAS, null);
        if (saved != null) return saved;
        if (!create) throw new IllegalStateException("令牌加密密钥已不可用");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }

    static void write(SharedPreferences.Editor editor, String field, String value) throws Exception {
        editor.remove(field);
        if (value.isEmpty()) {
            editor.remove(field + "_sealed");
            return;
        }
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(field.getBytes(StandardCharsets.UTF_8));
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String encrypted = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        editor.putString(field + "_sealed", iv + ":" + encrypted);
    }

    static String read(SharedPreferences prefs, String field, String fallback) throws Exception {
        String sealed = prefs.getString(field + "_sealed", null);
        if (sealed != null) {
            String[] parts = sealed.split(":", 2);
            if (parts.length != 2) throw new IllegalArgumentException("令牌存储格式无效");
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, key(false),
                    new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            cipher.updateAAD(field.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        }
        String legacy = prefs.getString(field, fallback);
        if (!legacy.isEmpty()) {
            SharedPreferences.Editor editor = prefs.edit();
            write(editor, field, legacy);
            if (!editor.commit()) throw new IllegalStateException("旧令牌迁移失败");
        }
        return legacy;
    }
}
