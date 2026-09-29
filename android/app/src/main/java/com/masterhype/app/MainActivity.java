package com.masterhype.app;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    // True quando questa Activity è una recreate() dopo onRenderProcessGone:
    // il renderer lo legge (MediaSessionPlugin.resumeState) per riprendere la
    // riproduzione — mentre un avvio normale NON deve mai auto-playare.
    static volatile boolean renderCrashed = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin app-locale (non npm): va registrato prima del bridge
        registerPlugin(MediaSessionPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(DiscoveryPlugin.class);
        registerPlugin(FilesPlugin.class);
        super.onCreate(savedInstanceState);
        // Renderer WebView ucciso dal sistema (RAM sotto pressione — molto
        // comune con audio+video attivi in background): senza un handler che
        // restituisca true il framework CRASHA l'app al rientro — lo schermo
        // resta congelato sull'ultimo frame ("non risponde al touch" e il
        // tasto indietro non naviga). true = gestiamo noi: la WebView morta
        // si distrugge e l'activity si ricrea — reload pulito, niente crash.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                renderCrashed = true;
                try { webView.destroy(); } catch (Exception ignored) {}
                new Handler(Looper.getMainLooper()).post(() -> {
                    if (!isFinishing() && !isDestroyed()) recreate();
                });
                return true;
            }
        });
    }

    // Tasto indietro: prima lo offriamo alla UI web — chiude il lettore
    // espanso, i pannelli aperti, il dettaglio artista, poi torna alla
    // schermata precedente. Se la pagina non consuma (o non è pronta)
    // vale il comportamento standard (history → minimizza l'app).
    @Override
    public void onBackPressed() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) { defaultBack(); return; }
        wv.evaluateJavascript(
            "window.__mhBack ? !!window.__mhBack() : false",
            (v) -> { if (!"true".equals(v)) defaultBack(); });
    }

    private void defaultBack() {
        super.onBackPressed();
    }
}
