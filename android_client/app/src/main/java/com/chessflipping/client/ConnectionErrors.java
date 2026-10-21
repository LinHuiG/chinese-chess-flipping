package com.chessflipping.client;

import java.io.EOFException;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.UnknownHostException;
import javax.net.ssl.SSLException;

/** User-facing transport errors contain only a local stage, never remote text or credentials. */
final class ConnectionErrors {
    private ConnectionErrors(){}
    static String describe(Throwable error,String stage){
        for(Throwable cause=error;cause!=null;cause=cause.getCause()){
            if(cause instanceof UnknownHostException)return "服务端域名解析失败，请检查服务器地址和 DNS";
            if(cause instanceof SSLException)return "服务端 HTTPS/WSS 证书或安全连接失败，请检查证书和服务器配置";
            if(cause instanceof InterruptedIOException)return "服务端"+stage+"超时，请检查网络和服务状态；正在尝试重连";
            if(cause instanceof ConnectException)return "服务端连接失败，请检查地址、端口及服务是否启动；正在尝试重连";
            if(cause instanceof EOFException)return "服务端在"+stage+"期间关闭连接；正在尝试重连";
            if(cause instanceof SocketException)return "服务端"+stage+"中断，请检查网络；正在尝试重连";
            if(cause.getCause()==cause)break;
        }
        return "服务端"+stage+"失败，请检查网络、服务状态及客户端版本；正在尝试重连";
    }
}
