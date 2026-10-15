package com.chessflipping.client;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;

/** Small local host save. Tokens are encrypted; passwords are never accepted. */
final class WatchSaveStore {
    static final int MAX_BYTES=256*1024;
    private static final byte[] HEADER={'C','W','S',1};
    private static final String READ_ERROR="观影存档无法读取或解密，请删除后重新保存",WRITE_ERROR="观影存档保存失败，请检查本机存储";
    private final AtomicFile file;private final String alias;
    WatchSaveStore(Context context){this(new File(context.getNoBackupFilesDir(),"watch-save.enc"),"cyber-room.watch-save.v1");}
    WatchSaveStore(File path,String alias){file=new AtomicFile(path);this.alias=alias;}
    private SecretKey key(boolean create)throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(store.containsAlias(alias))return (SecretKey)store.getKey(alias,null);
        if(!create)throw new IOException(READ_ERROR);
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private static void validate(String text)throws Exception{
        if(text.getBytes(StandardCharsets.UTF_8).length>MAX_BYTES)throw new IOException("观影存档超过大小限制");
        JSONTokener parser=new JSONTokener(text);Object value=parser.nextValue();if(!(value instanceof JSONObject)||parser.nextClean()!=0||hasPassword(value))throw new IOException("观影存档格式无效，不能保存密码");
    }
    private static boolean hasPassword(Object value)throws JSONException{
        if(value instanceof JSONObject){JSONObject object=(JSONObject)value;for(Iterator<String> keys=object.keys();keys.hasNext();){String key=keys.next();if("password".equalsIgnoreCase(key)||hasPassword(object.get(key)))return true;}}
        else if(value instanceof JSONArray){JSONArray values=(JSONArray)value;for(int i=0;i<values.length();i++)if(hasPassword(values.get(i)))return true;}
        return false;
    }
    synchronized String read()throws IOException{
        byte[] plain=null;
        try{
            if(!file.getBaseFile().exists()&&!new File(file.getBaseFile()+".bak").exists())return null;
            byte[] encrypted;
            try(InputStream input=file.openRead();ByteArrayOutputStream output=new ByteArrayOutputStream()){
                byte[] buffer=new byte[4096];int count;while((count=input.read(buffer))!=-1){if(output.size()+count>MAX_BYTES+64)throw new IOException(READ_ERROR);output.write(buffer,0,count);}encrypted=output.toByteArray();
            }
            if(encrypted.length<32||!Arrays.equals(HEADER,Arrays.copyOf(encrypted,4)))throw new IOException(READ_ERROR);
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(false),new GCMParameterSpec(128,encrypted,4,12));cipher.updateAAD(HEADER);
            plain=cipher.doFinal(encrypted,16,encrypted.length-16);String result=new String(plain,StandardCharsets.UTF_8);validate(result);return result;
        }catch(Exception error){throw new IOException(READ_ERROR);}finally{if(plain!=null)Arrays.fill(plain,(byte)0);}
    }
    synchronized boolean write(String text)throws IOException{
        if(text==null||"null".equals(text.trim())){
            file.delete();File path=file.getBaseFile();
            if(path.exists()||new File(path+".new").exists()||new File(path+".bak").exists())throw new IOException("观影存档删除失败");
            try{KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);store.deleteEntry(alias);}catch(Exception error){throw new IOException("观影存档密钥清理失败");}
            return true;
        }
        byte[] plain=null;FileOutputStream output=null;
        try{
            validate(text);plain=text.getBytes(StandardCharsets.UTF_8);
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(true));cipher.updateAAD(HEADER);
            byte[] encrypted=cipher.doFinal(plain),iv=cipher.getIV();if(iv.length!=12)throw new IOException(WRITE_ERROR);
            output=file.startWrite();output.write(HEADER);output.write(iv);output.write(encrypted);file.finishWrite(output);output=null;return true;
        }catch(Exception error){if(output!=null)file.failWrite(output);throw new IOException(WRITE_ERROR);}finally{if(plain!=null)Arrays.fill(plain,(byte)0);}
    }
}
