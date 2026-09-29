package com.masterhype.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground service "mediaPlayback": tiene il processo vivo (e la WebView che
 * suona) a schermo spento/app in background, e fornisce la media session di
 * sistema — notifica con controlli, lockscreen, tasti Bluetooth/auricolari.
 *
 * Flusso: JS → MediaSessionPlugin.updateSession → ACTION_UPDATE qui.
 *         Pulsanti sessione/notifica → MediaSessionPlugin.emit → JS.
 * La riproduzione vera resta nella WebView (<audio>): questo servizio non
 * decodifica niente, garantisce solo sopravvivenza + controlli.
 * NIENTE audio focus proprio: Chromium lo gestisce già per <audio> — una
 * richiesta parallela gli rubava il focus e ci auto-pausavamo dopo ~1s.
 */
public class PlaybackService extends Service {
    public static final String ACTION_UPDATE = "com.masterhype.app.ms.UPDATE";
    private static final String ACTION_TOGGLE = "com.masterhype.app.ms.TOGGLE";
    private static final String ACTION_NEXT = "com.masterhype.app.ms.NEXT";
    private static final String ACTION_PREV = "com.masterhype.app.ms.PREV";
    private static final String ACTION_DISMISS = "com.masterhype.app.ms.DISMISS";
    private static final int NOTIF_ID = 44171;
    private static final String CHANNEL = "playback";

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private boolean wakeHeld;
    private BroadcastReceiver noisy;

    private String title = "", artist = "", album = "", artUrl = "", videoId = "";
    private long durationMs, positionMs;
    private boolean playing;
    private Bitmap art;
    private String artLoaded = "";

    // Ultimo stato spinto dalla WebView, in statici: il servizio vive nel
    // processo APP e sopravvive alla morte del RENDER process WebView —
    // dopo onRenderProcessGone → recreate() il renderer può riprendere il
    // brano che suonava (MediaSessionPlugin.resumeState). Azzerato in
    // onDestroy: un servizio fermo non deve mai autorizzare un auto-play.
    static volatile String lastVideoId = "", lastTitle = "", lastArtist = "";
    static volatile boolean lastPlaying = false;
    static volatile long lastPositionMs = 0;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    public static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, PlaybackService.class)); } catch (Exception ignored) {}
    }

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSession(this, "MasterHype");
        // Tasti multimediali hardware/BT: il framework li recapita alla sessione
        // attiva; il callback li inoltra alla WebView come azioni.
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MediaSessionPlugin.emit("play"); }
            @Override public void onPause() { MediaSessionPlugin.emit("pause"); }
            @Override public void onSkipToNext() { MediaSessionPlugin.emit("next"); }
            @Override public void onSkipToPrevious() { MediaSessionPlugin.emit("prev"); }
            @Override public void onSeekTo(long pos) { MediaSessionPlugin.emit("seek", pos); }
            @Override public void onStop() { MediaSessionPlugin.emit("stop"); }
        });
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "masterhype:playback");
        wakeLock.setReferenceCounted(false);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Riproduzione", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        // Cuffie staccate / uscita cambiata: pausa (comportamento standard dei player)
        noisy = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { MediaSessionPlugin.emit("pause"); }
        };
        ContextCompat.registerReceiver(this, noisy,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Restart post-kill senza intent: niente stato da mostrare — non
        // resuscitare una notifica fantasma senza la WebView che suona.
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String act = intent.getAction() != null ? intent.getAction() : "";
        switch (act) {
            case ACTION_TOGGLE: MediaSessionPlugin.emit("toggle"); return START_STICKY;
            case ACTION_NEXT: MediaSessionPlugin.emit("next"); return START_STICKY;
            case ACTION_PREV: MediaSessionPlugin.emit("prev"); return START_STICKY;
            case ACTION_DISMISS:
                // Notifica swipata via da pausa: la musica è già ferma —
                // niente evento JS (un push di stato farebbe ricomparire la notifica)
                stopSelf();
                return START_STICKY;
            default: break; // ACTION_UPDATE: stato spinto dalla WebView
        }
        title = s(intent.getStringExtra("title"));
        artist = s(intent.getStringExtra("artist"));
        album = s(intent.getStringExtra("album"));
        artUrl = s(intent.getStringExtra("artUrl"));
        videoId = s(intent.getStringExtra("videoId"));
        durationMs = intent.getLongExtra("durationMs", 0);
        positionMs = intent.getLongExtra("positionMs", 0);
        playing = intent.getBooleanExtra("playing", false);
        lastVideoId = videoId; lastTitle = title; lastArtist = artist;
        lastPlaying = playing; lastPositionMs = positionMs;

        // Contratto startForegroundService: foreground SUBITO (entro ~5s)
        goForeground();
        session.setActive(true);
        refresh();
        if (playing) grabWake(); else releaseWake();
        maybeLoadArt();
        return START_STICKY;
    }

    private static String s(String v) { return v == null ? "" : v; }

    private void goForeground() {
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIF_ID, n);
    }

    private void refresh() {
        // Metadati (lockscreen, quick settings media player Android 13+)
        MediaMetadata.Builder mb = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (art != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(mb.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            // (position, speed): Android estrapola la posizione tra un update e l'altro
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, playing ? 1f : 0f)
            .build());
        // Aggiorna la notifica foreground già visibile
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIF_ID, buildNotification());
    }

    private PendingIntent pi(String action) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification.Action act(String action, int iconRes, String label) {
        return new Notification.Action.Builder(
            android.graphics.drawable.Icon.createWithResource(this, iconRes), label, pi(action)).build();
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.isEmpty() ? "MasterHype" : title)
            .setContentText(artist)
            .setContentIntent(tap)
            .setOngoing(playing)                    // in play non si swipa via; in pausa sì
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setDeleteIntent(pi(ACTION_DISMISS))
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        if (art != null) b.setLargeIcon(art);
        b.addAction(act(ACTION_PREV, android.R.drawable.ic_media_previous, "Precedente"));
        b.addAction(act(ACTION_TOGGLE,
            playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            playing ? "Pausa" : "Play"));
        b.addAction(act(ACTION_NEXT, android.R.drawable.ic_media_next, "Successivo"));
        return b.build();
    }

    // Copertina da URL (LAN http:// del PC o https YouTube): scaricata in
    // background, poi metadati + notifica si aggiornano col bitmap.
    private void maybeLoadArt() {
        if (artUrl.equals(artLoaded)) return;
        final String u = artUrl;
        artLoaded = u;
        io.submit(() -> {
            Bitmap bmp = null;
            if (!u.isEmpty()) {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(6000);
                    bmp = BitmapFactory.decodeStream(c.getInputStream());
                    c.disconnect();
                } catch (Exception ignored) {}
            }
            art = bmp;
            main.post(this::refreshQuiet);
        });
    }

    private void refreshQuiet() {
        try { refresh(); } catch (Exception ignored) {}
    }

    private void grabWake() {
        if (!wakeHeld) { wakeLock.acquire(); wakeHeld = true; }
    }

    private void releaseWake() {
        if (wakeHeld) { try { wakeLock.release(); } catch (Exception ignored) {} wakeHeld = false; }
    }

    @Override
    public void onDestroy() {
        lastPlaying = false; lastVideoId = ""; lastTitle = ""; lastArtist = ""; lastPositionMs = 0;
        try { unregisterReceiver(noisy); } catch (Exception ignored) {}
        releaseWake();
        io.shutdownNow();
        if (session != null) { session.setActive(false); session.release(); session = null; }
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }

    // Swipe dai recenti: la WebView è morta insieme all'Activity — niente
    // musica possibile, il servizio si chiude (evita il restart sticky).
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
