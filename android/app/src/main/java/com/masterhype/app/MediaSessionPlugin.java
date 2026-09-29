package com.masterhype.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge JS ↔ PlaybackService: la WebView spinge lo stato now-playing
 * (updateSession) e riceve le azioni dei controlli multimediali
 * (notifica, lockscreen, Bluetooth, auricolari) via evento 'action'.
 */
@CapacitorPlugin(name = "MediaSession")
public class MediaSessionPlugin extends Plugin {
    static MediaSessionPlugin instance;
    private boolean askedNotifPerm;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        instance = null;
        // Rotazione/config change: l'activity viene ricreata ma non è una
        // vera chiusura — la musica e la notifica devono restare (la nuova
        // WebView riprenderà a spingere lo stato). Il servizio si ferma solo
        // quando l'activity muore davvero (swipe dai recenti, finish).
        android.app.Activity a = getActivity();
        if (a != null && a.isChangingConfigurations()) return;
        // Activity distrutta (swipe dai recenti): la WebView muore con lei —
        // la musica non può continuare: si ferma anche il servizio.
        PlaybackService.stop(getContext());
    }

    @PluginMethod
    public void updateSession(PluginCall call) {
        Context ctx = getContext();
        ensureNotifPermission();
        Intent i = new Intent(ctx, PlaybackService.class)
            .setAction(PlaybackService.ACTION_UPDATE)
            .putExtra("title", call.getString("title", ""))
            .putExtra("artist", call.getString("artist", ""))
            .putExtra("album", call.getString("album", ""))
            .putExtra("artUrl", call.getString("artUrl", ""))
            .putExtra("videoId", call.getString("videoId", ""))
            .putExtra("playing", Boolean.TRUE.equals(call.getBoolean("playing")))
            .putExtra("durationMs", call.getLong("durationMs", 0L))
            .putExtra("positionMs", call.getLong("positionMs", 0L));
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (RuntimeException e) {
            // API 31+: FGS vietata da background. Se il servizio è già in
            // foreground (musica in corso) il plain start passa comunque.
            try { ctx.startService(i); } catch (RuntimeException ignored) {}
        }
        call.resolve();
    }

    @PluginMethod
    public void stopSession(PluginCall call) {
        PlaybackService.stop(getContext());
        call.resolve();
    }

    // Recupero post-render-crash: il servizio (processo app) conserva l'ultimo
    // stato now-playing anche quando il renderer WebView è morto. Il flag
    // crashed viene dal MainActivity (onRenderProcessGone→recreate) e si
    // consuma alla prima lettura: un avvio normale non auto-playa MAI.
    @PluginMethod
    public void resumeState(PluginCall call) {
        JSObject d = new JSObject();
        d.put("crashed", MainActivity.renderCrashed);
        MainActivity.renderCrashed = false;
        d.put("playing", PlaybackService.lastPlaying);
        d.put("videoId", PlaybackService.lastVideoId);
        d.put("title", PlaybackService.lastTitle);
        d.put("artist", PlaybackService.lastArtist);
        d.put("positionMs", PlaybackService.lastPositionMs);
        call.resolve(d);
    }

    static void emit(String action) {
        emit(action, -1);
    }

    static void emit(String action, long positionMs) {
        MediaSessionPlugin p = instance;
        if (p == null) return;
        JSObject d = new JSObject();
        d.put("action", action);
        if (positionMs >= 0) d.put("positionMs", positionMs);
        p.notifyListeners("action", d);
    }

    // Android 13+: la notifica del servizio non si vede senza il permesso
    // runtime. Il servizio resta in foreground comunque (musica non si ferma),
    // ma senza i controlli — si chiede una sola volta, al primo play.
    private void ensureNotifPermission() {
        if (askedNotifPerm || Build.VERSION.SDK_INT < 33) return;
        askedNotifPerm = true;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
            getActivity().requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4417);
        }
    }
}
