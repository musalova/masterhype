package com.masterhype.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Aggiornamento APK in-app: info versione corrente, download nativo su file
 * (streaming su disco, non in RAM — l'APK pesa decine di MB), verifica sha256
 * e lancio dell'installer di sistema via FileProvider.
 * Sorgente tipica: il PC MasterHype sulla LAN (/update/app.apk, auth via
 * header X-MH-Token come tutte le altre API remote).
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo pi = Build.VERSION.SDK_INT >= 33
                    ? pm.getPackageInfo(getContext().getPackageName(), PackageManager.PackageInfoFlags.of(0))
                    : pm.getPackageInfo(getContext().getPackageName(), 0);
            JSObject r = new JSObject();
            long vc = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            r.put("versionCode", vc);
            r.put("versionName", pi.versionName != null ? pi.versionName : "");
            call.resolve(r);
        } catch (Exception e) {
            call.reject("info fallita: " + e.getMessage());
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("url mancante"); return; }
        final String token = call.getString("token");
        final String sha = call.getString("sha256");
        // HTTP su thread dedicato: il bridge non deve mai bloccarsi su 30+MB
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(15_000);
                c.setReadTimeout(60_000); // stallo tra byte, non deadline totale
                if (token != null) c.setRequestProperty("X-MH-Token", token);
                int code = c.getResponseCode();
                if (code != 200) { call.reject("HTTP " + code); return; }

                long total = c.getContentLength(); // -1 se il server non lo dichiara
                File out = new File(getContext().getCacheDir(), "mh-update.apk");
                MessageDigest md = sha != null ? MessageDigest.getInstance("SHA-256") : null;
                long got = 0; long lastEmit = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        fos.write(buf, 0, n);
                        if (md != null) md.update(buf, 0, n);
                        got += n;
                        if (got - lastEmit >= 512 * 1024) {
                            lastEmit = got;
                            JSObject p = new JSObject();
                            p.put("received", got);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                }
                if (total > 0 && got != total) { out.delete(); call.reject("download troncato: " + got + "/" + total + " byte"); return; }
                if (got == 0) { out.delete(); call.reject("file vuoto"); return; }
                if (md != null) {
                    StringBuilder hex = new StringBuilder();
                    for (byte b : md.digest()) hex.append(String.format("%02x", b));
                    if (!hex.toString().equalsIgnoreCase(sha)) {
                        out.delete();
                        call.reject("integrità fallita: sha256 non corrisponde");
                        return;
                    }
                }
                JSObject r = new JSObject();
                r.put("path", out.getAbsolutePath());
                r.put("size", got);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("download fallito: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }, "mh-update-dl").start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("path mancante"); return; }
        try {
            // Android 8+: serve il consenso "installa app sconosciute" per
            // questa sorgente. Prima volta → apriamo la pagina di sistema;
            // la JS riprova l'installazione dopo l'ok dell'utente.
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(s);
                JSObject r = new JSObject();
                r.put("needsPermission", true);
                call.resolve(r);
                return;
            }
            File f = new File(path);
            if (!f.isFile()) { call.reject("apk non trovato: " + path); return; }
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject());
        } catch (Exception e) {
            call.reject("install fallita: " + e.getMessage());
        }
    }
}
