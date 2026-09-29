import { useEffect, useRef, useState } from 'react';
import { X, CameraOff } from 'lucide-react';
import jsQR from 'jsqr';

// Scanner QR in-app per il pairing: fotocamera via getUserMedia (il WebChrome
// client nativo di Capacitor converte la richiesta in permesso CAMERA di
// sistema) + decode jsQR su canvas 2d. Overlay fullscreen: il video resta
// sotto la pagina e basta chiuderlo per spegnere tutto (cleanup tracks).
export default function QrScanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let alive = true;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr('Fotocamera non accessibile da questa app — usa la fotocamera del telefono sul QR');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        if (alive) setErr('Fotocamera non disponibile — controlla il permesso nelle Impostazioni di Android');
        return;
      }
      const v = videoRef.current;
      if (!alive || !v) return;
      v.srcObject = stream;
      await v.play().catch(() => {});
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const loop = () => {
        if (!alive) return;
        if (v.videoWidth && ctx) {
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (code?.data) { alive = false; onCode(code.data); return; }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
      {/* mirino */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-56 h-56 rounded-2xl border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
      </div>
      <div className="relative mt-auto mb-10 mx-auto text-center px-6 space-y-4">
        <div className="text-sm text-white/90 font-medium">Inquadra il codice in Impostazioni → Telefono sul PC</div>
        {err && <div className="text-xs text-amber-300 flex items-center justify-center gap-1.5"><CameraOff size={13} /> {err}</div>}
        <button onClick={onClose}
          className="px-6 py-2.5 rounded-xl bg-white/10 border border-white/25 text-white text-sm font-bold inline-flex items-center gap-2">
          <X size={14} /> Annulla
        </button>
      </div>
    </div>
  );
}
