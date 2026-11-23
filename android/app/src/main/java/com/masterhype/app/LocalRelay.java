package com.masterhype.app;

import android.util.Base64;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.util.Locale;

/**
 * Relay loopback per l'equalizzatore Web Audio (MediaElementSource).
 *
 * La WebView carica gli <audio> in crossOrigin='anonymous': le risorse senza
 * Access-Control-Allow-Origin verrebbero SILENZIATE dal grafo — e googlevideo
 * non manda ACAO. Questo mini-server su 127.0.0.1 accetta
 *   GET /gs?u=<target base64url>
 * e la risponde inoltrando al target con Range passthrough (seek audio) +
 * ACAO:* sulla risposta → la risorsa risulta CORS-clean.
 *
 * È raggiungibile da QUALSIASI app/browser sul telefono → NON è un proxy
 * aperto: allowlist host allineata a eqRelay.ts (googlevideo, audius).
 */
public final class LocalRelay {
    private static final String[] ALLOWED_SUFFIXES = {"googlevideo.com", "audius.co", "youtube.com"};
    private static ServerSocket server;
    private static int port;

    private LocalRelay() {}

    /** Porta del relay (0 in caso di errore). Avvio pigro, una volta sola. */
    public static synchronized int ensure() {
        if (server != null && !server.isClosed()) return port;
        try {
            server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            port = server.getLocalPort();
            Thread t = new Thread(LocalRelay::acceptLoop, "mh-relay");
            t.setDaemon(true);
            t.start();
            return port;
        } catch (Exception e) {
            return 0;
        }
    }

    private static void acceptLoop() {
        for (;;) {
            try {
                final Socket s = server.accept();
                Thread t = new Thread(() -> handle(s), "mh-relay-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return; // socket chiuso: il prossimo ensure() lo riapre
            }
        }
    }

    private static void handle(Socket s) {
        try {
            s.setSoTimeout(15000);
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream()));
            String line = in.readLine();
            if (line == null) { s.close(); return; }
            String[] parts = line.split(" ");
            String range = null;
            String h;
            while ((h = in.readLine()) != null && !h.isEmpty()) {
                int c = h.indexOf(':');
                if (c > 0 && h.substring(0, c).trim().equalsIgnoreCase("range")) {
                    range = h.substring(c + 1).trim();
                }
            }
            if (parts.length < 2 || !parts[0].equalsIgnoreCase("GET") || !parts[1].startsWith("/gs?u=")) {
                send(s, 404, null, null); return;
            }
            String b64 = parts[1].substring("/gs?u=".length());
            int amp = b64.indexOf('&');
            if (amp >= 0) b64 = b64.substring(0, amp);
            String target = new String(Base64.decode(b64, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
            URL url = new URL(target);
            String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.US);
            boolean allowed = "https".equalsIgnoreCase(url.getProtocol());
            if (allowed) {
                allowed = false;
                for (String suf : ALLOWED_SUFFIXES) {
                    if (host.equals(suf) || host.endsWith("." + suf)) { allowed = true; break; }
                }
            }
            if (!allowed) { send(s, 403, null, null); return; }

            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            send(s, code, c, c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream());
        } catch (Exception e) {
            try { send(s, 502, null, null); } catch (Exception ignored) {}
        }
    }

    private static void send(Socket s, int code, HttpURLConnection up, InputStream body) throws IOException {
        OutputStream out = s.getOutputStream();
        StringBuilder sb = new StringBuilder("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Connection: close\r\n");
        long len = -1;
        if (up != null) {
            String v;
            if ((v = up.getHeaderField("Content-Type")) != null) sb.append("Content-Type: ").append(v).append("\r\n");
            if ((v = up.getHeaderField("Content-Range")) != null) sb.append("Content-Range: ").append(v).append("\r\n");
            len = up.getContentLengthLong();
            if (len >= 0) sb.append("Content-Length: ").append(len).append("\r\n");
            sb.append("Accept-Ranges: bytes\r\n");
        } else {
            sb.append("Content-Length: 0\r\n");
        }
        sb.append("\r\n");
        out.write(sb.toString().getBytes("US-ASCII"));
        if (body != null) {
            byte[] buf = new byte[64 * 1024];
            int n;
            try {
                while ((n = body.read(buf)) >= 0) out.write(buf, 0, n);
            } catch (IOException ignored) { /* client partito (seek/skip): normale */ }
            try { body.close(); } catch (IOException ignored) {}
        }
        if (up != null) up.disconnect();
        try { out.flush(); } catch (IOException ignored) {}
        try { s.close(); } catch (IOException ignored) {}
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 301: case 302: return "Redirect";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 416: return "Range Not Satisfiable";
            default: return "Error";
        }
    }
}
