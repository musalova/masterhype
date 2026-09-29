import type { CapacitorConfig } from '@capacitor/cli';

// MasterHype per Android: la stessa UI React, in una WebView.
// Al primo avvio ConnectGate offre TRE percorsi senza digitazione:
// auto-scoperta UDP ("Accoppia telefono" sul PC → tap sul nome) + scanner QR
// in-app + modalità "senza PC"; il manuale (URL + token) è solo fallback.
// Poi gira tutto via HTTP verso il server LAN del PC (stesso DB e gusti).
const config: CapacitorConfig = {
  appId: 'com.masterhype.app',
  appName: 'MasterHype',
  webDir: 'out/renderer',
  server: {
    // Il PC serve http:// su LAN: WebView deve accettare cleartext
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  backgroundColor: '#0c0a10',
};

export default config;
