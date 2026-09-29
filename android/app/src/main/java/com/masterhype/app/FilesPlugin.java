package com.masterhype.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * File dell'utente (backup, report diagnostica, playlist M3U) salvati nella
 * cartella Download del telefono: parità con i "Salva con nome" del desktop.
 * Android 10+ → MediaStore.Downloads (nessun permesso richiesto, il file è
 * visibile nell'app File); Android 6-9 → cartella Download dell'app
 * (Android/data/.../files/Download: nessun permesso di storage necessario).
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        final String name = call.getString("name");
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        if (name == null || data == null) { call.reject("nome o dati mancanti"); return; }
        final String safe = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "").trim();
        if (safe.isEmpty()) { call.reject("nome non valido"); return; }
        new Thread(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                String shown;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver cr = getContext().getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MasterHype");
                    v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("MediaStore non disponibile");
                    try (OutputStream os = cr.openOutputStream(uri)) {
                        if (os == null) throw new Exception("scrittura non consentita");
                        os.write(bytes);
                    }
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    cr.update(uri, done, null, null);
                    shown = "Download/MasterHype/" + safe;
                } else {
                    File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getContext().getFilesDir();
                    if (!dir.exists() && !dir.mkdirs()) throw new Exception("cartella non creata");
                    File out = new File(dir, safe);
                    try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(bytes); }
                    shown = out.getAbsolutePath();
                }
                JSObject r = new JSObject();
                r.put("path", shown);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("salvataggio fallito: " + e.getMessage());
            }
        }, "mh-files-save").start();
    }
}
