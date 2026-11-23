package com.masterhype.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Cache condivisa per Android Auto: la WebView spinge l'albero sfogliabile
 * (stazioni/preferiti/playlist in JSON) e il PlaybackService lo stato
 * now-playing; AutoBrowseService li legge anche quando il renderer è morto
 * o non ancora avviato (browse a freddo dallo schermo dell'auto).
 *
 * Chiavi:
 *   tree    → JSON {stations,favorites,playlists} spinto da JS (updateAutoTree)
 *   state   → JSON now-playing scritto da PlaybackService a ogni update
 *   pending → mediaId da riprodurre richiesto dall'auto mentre JS era morto:
 *             il renderer lo consuma al boot (autoPending) e lo cancella.
 */
public final class AutoCache {
    private static final String PREFS = "mh_auto";
    private static final String K_TREE = "tree";
    private static final String K_STATE = "state";
    private static final String K_PENDING = "pending";

    private AutoCache() {}

    private static SharedPreferences p(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void saveTree(Context c, String json) {
        p(c).edit().putString(K_TREE, json).apply();
    }

    public static String tree(Context c) {
        return p(c).getString(K_TREE, "");
    }

    public static void saveState(Context c, String json) {
        p(c).edit().putString(K_STATE, json).apply();
    }

    public static String state(Context c) {
        return p(c).getString(K_STATE, "");
    }

    public static void setPending(Context c, String mediaId) {
        p(c).edit().putString(K_PENDING, mediaId).apply();
    }

    /** Legge il play pendente e lo cancella (una sola esecuzione). */
    public static String takePending(Context c) {
        SharedPreferences pr = p(c);
        String v = pr.getString(K_PENDING, "");
        if (!v.isEmpty()) pr.edit().remove(K_PENDING).apply();
        return v;
    }
}
