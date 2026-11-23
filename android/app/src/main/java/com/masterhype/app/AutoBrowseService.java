package com.masterhype.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.media.MediaMetadata;
import android.media.browse.MediaBrowser;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Bundle;
import android.service.media.MediaBrowserService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Android Auto: servizio di browse (framework, API 21+ — niente androidx).
 *
 * L'albero arriva da AutoCache (JSON spinto dalla WebView), così la
 * navigazione funziona anche quando il renderer è in background o non
 * ancora partito: Stazioni → st:<id>, Preferiti → f:<videoId>,
 * Playlist → pl:<id> (cartella) → pt:<plId>:<videoId>.
 *
 * La riproduzione vera resta nella WebView: onPlayFromMediaId inoltra il
 * mediaId al renderer via MediaSessionPlugin.emit('auto-play'); se il
 * plugin non c'è (app chiusa) lo parcheggia in AutoCache.pending e apre
 * l'activity — il renderer lo raccoglie al boot (autoPending).
 *
 * Sessione propria: i controlli dell'auto (volante/pulsanti) entrano qui
 * quando il servizio di playback non è attivo; durante la riproduzione
 * vince sempre la sessione di PlaybackService (setActive a ogni update).
 * Stesso canale emit() → stesse azioni JS.
 */
public class AutoBrowseService extends MediaBrowserService {
    private static final String ROOT = "root";
    private static final String DIR_ST = "dir:stazioni";
    private static final String DIR_FAV = "dir:preferiti";

    private MediaSession session;
    private SharedPreferences prefs;
    private SharedPreferences.OnSharedPreferenceChangeListener prefListener;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("mh_auto", MODE_PRIVATE);
        session = new MediaSession(this, "MasterHypeAuto");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MediaSessionPlugin.emit("play"); }
            @Override public void onPause() { MediaSessionPlugin.emit("pause"); }
            @Override public void onSkipToNext() { MediaSessionPlugin.emit("next"); }
            @Override public void onSkipToPrevious() { MediaSessionPlugin.emit("prev"); }
            @Override public void onSeekTo(long pos) { MediaSessionPlugin.emit("seek", pos); }
            @Override public void onStop() { MediaSessionPlugin.emit("stop"); }

            @Override
            public void onPlayFromMediaId(String mediaId, Bundle extras) {
                if (mediaId == null || mediaId.isEmpty()) return;
                MediaSessionPlugin p = MediaSessionPlugin.instance;
                if (p != null) {
                    MediaSessionPlugin.emit("auto-play", mediaId);
                } else {
                    // Renderer morto/app chiusa: parcheggia la richiesta e
                    // apri l'app — il renderer esegue il play al boot.
                    AutoCache.setPending(AutoBrowseService.this, mediaId);
                    Intent open = new Intent(AutoBrowseService.this, MainActivity.class);
                    open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(open);
                }
            }
        });
        session.setActive(true);
        setSessionToken(session.getSessionToken());
        applyState();
        prefListener = (p, k) -> { if ("state".equals(k)) applyState(); };
        prefs.registerOnSharedPreferenceChangeListener(prefListener);
    }

    // Stato now-playing specchiato dalla WebView (scritto da PlaybackService):
    // lo schermo dell'auto mostra il brano corrente anche a browse aperto.
    private void applyState() {
        try {
            JSONObject s = new JSONObject(AutoCache.state(this));
            session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.optString("title"))
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.optString("artist"))
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.optString("album", "MasterHype"))
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.optLong("durationMs"))
                .build());
            boolean playing = s.optBoolean("playing");
            session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP | PlaybackState.ACTION_PLAY_FROM_MEDIA_ID)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                    s.optLong("positionMs"), playing ? 1f : 0f)
                .build());
        } catch (Exception ignored) {}
    }

    @Override
    public BrowserRoot onGetRoot(String clientPackageName, int clientUid, Bundle rootHints) {
        // App personale: nessuna whitelist pacchetti — serve qualsiasi host
        // compatibile col protocollo (Android Auto, automotive, debug).
        return new BrowserRoot(ROOT, null);
    }

    private static MediaBrowser.MediaItem dir(String id, String title, int count) {
        android.media.MediaDescription d = new android.media.MediaDescription.Builder()
            .setMediaId(id).setTitle(title).setSubtitle(count + " elementi").build();
        return new MediaBrowser.MediaItem(d, MediaBrowser.MediaItem.FLAG_BROWSABLE);
    }

    private static MediaBrowser.MediaItem item(String id, String title, String artist, String art) {
        android.media.MediaDescription.Builder b = new android.media.MediaDescription.Builder()
            .setMediaId(id).setTitle(title);
        if (artist != null && !artist.isEmpty()) b.setSubtitle(artist);
        if (art != null && art.startsWith("http")) b.setIconUri(Uri.parse(art));
        return new MediaBrowser.MediaItem(b.build(), MediaBrowser.MediaItem.FLAG_PLAYABLE);
    }

    @Override
    public void onLoadChildren(String parentId, Result<List<MediaBrowser.MediaItem>> result) {
        result.sendResult(children(parentId));
    }

    private List<MediaBrowser.MediaItem> children(String parentId) {
        List<MediaBrowser.MediaItem> out = new ArrayList<>();
        try {
            JSONObject tree = new JSONObject(AutoCache.tree(this));
            if (ROOT.equals(parentId)) {
                JSONArray st = tree.optJSONArray("stations");
                JSONArray fav = tree.optJSONArray("favorites");
                JSONArray pls = tree.optJSONArray("playlists");
                out.add(dir(DIR_ST, "Le tue stazioni", st == null ? 0 : st.length()));
                out.add(dir(DIR_FAV, "Preferiti", fav == null ? 0 : fav.length()));
                if (pls != null) for (int i = 0; i < pls.length(); i++) {
                    JSONObject p = pls.getJSONObject(i);
                    JSONArray t = p.optJSONArray("tracks");
                    out.add(dir("pl:" + p.getInt("id"), p.optString("name"), t == null ? 0 : t.length()));
                }
            } else if (DIR_ST.equals(parentId)) {
                JSONArray st = tree.optJSONArray("stations");
                if (st != null) for (int i = 0; i < st.length(); i++) {
                    JSONObject s = st.getJSONObject(i);
                    out.add(item("st:" + s.getString("id"), s.optString("name"), "Stazione", null));
                }
            } else if (DIR_FAV.equals(parentId)) {
                addTracks(out, tree.optJSONArray("favorites"), "f:");
            } else if (parentId.startsWith("pl:")) {
                int plId = Integer.parseInt(parentId.substring(3));
                JSONArray pls = tree.optJSONArray("playlists");
                if (pls != null) for (int i = 0; i < pls.length(); i++) {
                    JSONObject p = pls.getJSONObject(i);
                    if (p.getInt("id") == plId) {
                        addTracks(out, p.optJSONArray("tracks"), "pt:" + plId + ":");
                        break;
                    }
                }
            }
        } catch (Exception ignored) {}
        return out;
    }

    private void addTracks(List<MediaBrowser.MediaItem> out, JSONArray tracks, String prefix) {
        if (tracks == null) return;
        for (int i = 0; i < tracks.length(); i++) {
            JSONObject t = tracks.optJSONObject(i);
            if (t == null) continue;
            String vid = t.optString("videoId");
            if (vid.isEmpty()) continue;
            out.add(item(prefix + vid, t.optString("title"), t.optString("artist"), t.optString("art")));
        }
    }

    @Override
    public void onDestroy() {
        if (prefListener != null) prefs.unregisterOnSharedPreferenceChangeListener(prefListener);
        if (session != null) { session.setActive(false); session.release(); session = null; }
        super.onDestroy();
    }
}
