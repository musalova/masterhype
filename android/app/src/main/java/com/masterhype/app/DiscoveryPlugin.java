package com.masterhype.app;

import android.content.Context;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;

// Auto-scoperta del PC sulla LAN: il PC invia "MH1|<porta>|<hostname>" in
// broadcast UDP sulla 48485 ogni ~2.5s (src/main/discovery.ts). Qui si
// ascolta e si notifica al renderer — il gate di pairing mostra il PC trovato
// senza che l'utente digiti l'indirizzo.
//
// MulticastLock: su molti telefoni i pacchetti broadcast vengono filtrati
// dal driver Wi-Fi finché l'app non tiene il lock (permesso
// CHANGE_WIFI_MULTICAST_STATE nel manifest). Da acquisire prima del bind.
@CapacitorPlugin(name = "Discovery")
public class DiscoveryPlugin extends Plugin {
    private static final int PORT = 48485;
    private static final String MAGIC = "MH1";

    private DatagramSocket socket;
    private Thread thread;
    private WifiManager.MulticastLock mlock;

    @PluginMethod
    public void listen(PluginCall call) {
        if (thread != null) { call.resolve(); return; }
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                mlock = wm.createMulticastLock("mh-discovery");
                mlock.setReferenceCounted(true);
                mlock.acquire();
            }
            DatagramSocket s = new DatagramSocket(null);
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(PORT));
            socket = s;
            thread = new Thread(() -> receiveLoop(s), "mh-discovery");
            thread.setDaemon(true);
            thread.start();
            call.resolve();
        } catch (Exception e) {
            releaseLock();
            call.reject("discovery non disponibile: " + e.getMessage());
        }
    }

    private void receiveLoop(DatagramSocket s) {
        while (socket == s && !s.isClosed()) {
            try {
                byte[] buf = new byte[512];
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                s.receive(p); // bloccante: il thread muore chiudendo il socket
                String msg = new String(p.getData(), 0, p.getLength(), "UTF-8").trim();
                String[] parts = msg.split("\\|", -1);
                if (parts.length < 3 || !MAGIC.equals(parts[0])) continue;
                int port;
                try { port = Integer.parseInt(parts[1]); } catch (NumberFormatException nfe) { continue; }
                if (port <= 0 || port > 65535 || p.getAddress() == null) continue;
                JSObject o = new JSObject();
                o.put("host", p.getAddress().getHostAddress());
                o.put("port", port);
                o.put("name", parts[2]);
                notifyListeners("found", o);
            } catch (Exception e) {
                if (s.isClosed()) return; // stop() richiesto
                // errore transitorio (Wi-Fi in transizione): si resta in ascolto
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        close();
        call.resolve();
    }

    private void releaseLock() {
        try { if (mlock != null && mlock.isHeld()) mlock.release(); } catch (Exception ignored) {}
        mlock = null;
    }

    private void close() {
        DatagramSocket s = socket;
        socket = null;
        thread = null;
        if (s != null) { try { s.close(); } catch (Exception ignored) {} }
        releaseLock();
    }

    @Override
    protected void handleOnDestroy() {
        close();
    }
}
