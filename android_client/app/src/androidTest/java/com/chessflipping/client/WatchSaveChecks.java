package com.chessflipping.client;

import android.app.Instrumentation;
import android.os.Bundle;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.concurrent.*;
import android.webkit.*;

/** Instrumentation suite with no accounts or microphone. */
final class WatchSaveChecks {
    private final Instrumentation owner;
    WatchSaveChecks(Instrumentation owner){this.owner=owner;}
    public static final class ErrorBridge {
        final SecureStore store;final CountDownLatch done=new CountDownLatch(1);volatile boolean caught;
        ErrorBridge(SecureStore store){this.store=store;}
        @JavascriptInterface public String read(){try{return store.read();}catch(IOException error){throw new IllegalStateException(error.getMessage());}}
        @JavascriptInterface public void result(boolean caught){this.caught=caught;done.countDown();}
    }
    private void bridgeError(SecureStore store)throws Exception{
        ErrorBridge bridge=new ErrorBridge(store);WebView[] web=new WebView[1];
        try{
            owner.runOnMainSync(()->{web[0]=new WebView(owner.getTargetContext());web[0].getSettings().setJavaScriptEnabled(true);web[0].addJavascriptInterface(bridge,"SaveTest");web[0].loadDataWithBaseURL("https://appassets.androidplatform.net/","<script>let caught=false;try{SaveTest.read()}catch(error){caught=true}SaveTest.result(caught)</script>","text/html","UTF-8",null);});
            check(bridge.done.await(10,TimeUnit.SECONDS)&&bridge.caught,"native read error must reject in JavaScript rather than appear empty");
        }finally{owner.runOnMainSync(()->{if(web[0]!=null)web[0].destroy();});}
    }
    private static void check(boolean ok,String description){if(!ok)throw new AssertionError(description);}
    Bundle run(){
        Bundle result=new Bundle();boolean success=false;
        File path=new File(owner.getTargetContext().getNoBackupFilesDir(),"watch-save-test.enc");
        String alias="cyber-room.watch-save.test";SecureStore store=new SecureStore(path,alias);
        try{
            store.write(null);check(store.read()==null,"empty store");
            String data="{\"version\":1,\"source\":{\"token\":\"synthetic-token-only\"},\"position\":42}";
            store.write(data);check(data.equals(store.read()),"encrypted roundtrip");
            byte[] encrypted=Files.readAllBytes(path.toPath());check(!new String(encrypted,StandardCharsets.ISO_8859_1).contains("synthetic-token-only"),"credential plaintext in file");
            KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);check(keys.getKey(alias,null).getEncoded()==null,"key must be non-exportable");
            store.write("{\"version\":1,\"position\":60}");check(store.read().contains("60"),"atomic replacement");
            boolean rejected=false;store.write("{\"value\":\"encrypted generic data\"}");check(store.read().contains("encrypted generic data"),"generic JSON accepted");
            rejected=false;try{store.write("{\"token\":\""+"x".repeat(SecureStore.MAX_BYTES)+"\"}");}catch(IOException expected){rejected=true;}check(rejected,"size bound");
            encrypted[encrypted.length-1]^=1;Files.write(path.toPath(),encrypted);rejected=false;try{store.read();}catch(IOException expected){rejected=true;}check(rejected,"tampered file rejected");bridgeError(store);
            store.write("null");check(store.read()==null,"delete damaged record");check(!keys.containsAlias(alias),"delete removes keystore entry");
            store.write(data);store.write("null");check(store.read()==null&&!path.exists(),"delete after write cannot be resurrected");
            result.putString("result","PASS Android Keystore AES/GCM roundtrip, non-exportable key, no plaintext token, atomic replace, corruption, size rejection and deletion");success=true;
        }catch(Throwable error){result.putString("error",error.getClass().getSimpleName()+": "+error.getMessage());}
        finally{try{store.write(null);}catch(IOException ignored){}}
        result.putBoolean("success",success);return result;
    }
}
