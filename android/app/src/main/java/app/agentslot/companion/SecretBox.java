package app.agentslot.companion;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Wraps the saved-server blob so the stored passwords are not readable at rest.
 *
 * A real key: AES-256/GCM with a key that lives in the Android Keystore and never leaves it
 * (on a device with a secure element it cannot even be extracted by root). The ciphertext and
 * its IV go into SharedPreferences. This is not "encrypted preferences" theatre — it is the
 * smallest honest thing that keeps a saved password out of a plain file.
 *
 * If the Keystore refuses (some emulators/ROMs), callers fall back to plain storage and the UI
 * says so instead of pretending.
 */
final class SecretBox {
    private static final String ALIAS = "agentslot.profiles.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;

    /** Returns "enc:<ivB64>:<ctB64>" or null when the platform would not cooperate. */
    static String seal(String plain) {
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return "enc:" + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
        } catch (Throwable t) {
            return null;
        }
    }

    /** Opens "enc:…"; returns null when it cannot (wrong key after a restore, corrupt blob). */
    static String open(String sealed) {
        try {
            String[] parts = sealed.split(":", 3);
            if (parts.length != 3 || !"enc".equals(parts[0])) return null;
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key(),
                new GCMParameterSpec(TAG_BITS, Base64.decode(parts[1], Base64.NO_WRAP)));
            byte[] pt = cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP));
            return new String(pt, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // no user-authentication requirement: the service must be able to read the device
            // token while the phone is locked (that is the whole point of the channel)
            .build());
        return gen.generateKey();
    }

    static boolean available(Context context) {
        return seal("probe") != null;
    }
}