package com.chessflipping.protocol;

import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.interfaces.ECPublicKey;
import java.security.spec.*;
import java.util.Arrays;

/** ECDH P-256 + RFC 5869 HKDF-SHA256. No provider is hard-coded (Android/JDK). */
public final class KeyExchange {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final byte[] LABEL = "chess-flipping/tcp/v2".getBytes(StandardCharsets.US_ASCII);
    private KeyExchange() {}

    public static KeyPair generateKeyPair() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
        return generator.generateKeyPair();
    }

    /** Raw handshake body: 32 random bytes followed by DER SubjectPublicKeyInfo. */
    public static byte[] hello(KeyPair keyPair) {
        byte[] random = new byte[32];
        RANDOM.nextBytes(random);
        return WireProtocol.join(random, keyPair.getPublic().getEncoded());
    }

    public static PublicKey publicKey(byte[] hello) throws GeneralSecurityException, IOException {
        if (hello.length <= 32 || hello.length > 256) throw new IOException("Invalid key exchange body");
        PublicKey key = KeyFactory.getInstance("EC").generatePublic(
                new X509EncodedKeySpec(Arrays.copyOfRange(hello, 32, hello.length)));
        if (!(key instanceof ECPublicKey)) throw new GeneralSecurityException("Expected EC key");
        ECPublicKey ec = (ECPublicKey)key;
        AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
        params.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec expected = params.getParameterSpec(ECParameterSpec.class);
        ECParameterSpec actual = ec.getParams();
        if (!expected.getCurve().equals(actual.getCurve()) || !expected.getGenerator().equals(actual.getGenerator())
                || !expected.getOrder().equals(actual.getOrder()) || expected.getCofactor() != actual.getCofactor())
            throw new GeneralSecurityException("Expected P-256 key");
        // Explicitly validate the peer's point, in addition to provider checks.
        BigInteger p = ((ECFieldFp)expected.getCurve().getField()).getP();
        BigInteger x = ec.getW().getAffineX(), y = ec.getW().getAffineY();
        if (x == null || y == null || x.signum() < 0 || x.compareTo(p) >= 0 || y.signum() < 0 || y.compareTo(p) >= 0
                || !y.multiply(y).mod(p).equals(x.multiply(x).multiply(x)
                .add(expected.getCurve().getA().multiply(x)).add(expected.getCurve().getB()).mod(p)))
            throw new GeneralSecurityException("Invalid EC point");
        return key;
    }

    public static byte[] transcript(byte[] request, byte[] serverHello, byte[] clientKey) throws GeneralSecurityException {
        return sha256(WireProtocol.join(request, serverHello, clientKey));
    }

    public static SecureSession derive(boolean client, KeyPair local, byte[] serverHello, byte[] clientHello,
                                       byte[] transcript) throws GeneralSecurityException, IOException {
        if (transcript.length != 32) throw new IOException("Invalid transcript hash");
        // Validate both message bodies before accessing their random values.
        PublicKey server = publicKey(serverHello), peerClient = publicKey(clientHello);
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(local.getPrivate());
        agreement.doPhase(client ? server : peerClient, true);
        byte[] secret = agreement.generateSecret();
        byte[] material = null;
        try {
            byte[] salt = sha256(WireProtocol.join(Arrays.copyOf(serverHello, 32), Arrays.copyOf(clientHello, 32)));
            material = hkdf(secret, salt, WireProtocol.join(LABEL, transcript), 72);
            return new SecureSession(client, material);
        } finally {
            Arrays.fill(secret, (byte)0);
            if (material != null) Arrays.fill(material, (byte)0);
        }
    }

    static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info, int length) throws GeneralSecurityException {
        if (length < 1 || length > 255 * 32) throw new IllegalArgumentException("HKDF length");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm), previous = new byte[0], result = new byte[length];
        try {
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            for (int offset = 0, block = 1; offset < length; block++) {
                mac.update(previous);
                mac.update(info);
                byte[] next = mac.doFinal(new byte[]{(byte)block});
                Arrays.fill(previous, (byte)0);
                previous = next;
                int count = Math.min(previous.length, length - offset);
                System.arraycopy(previous, 0, result, offset, count);
                offset += count;
            }
            return result;
        } finally {
            Arrays.fill(prk, (byte)0);
            Arrays.fill(previous, (byte)0);
        }
    }

    private static byte[] sha256(byte[] bytes) throws GeneralSecurityException {
        return MessageDigest.getInstance("SHA-256").digest(bytes);
    }
}
