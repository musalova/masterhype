// Logo MasterHype — la stessa icona dell'app (src/renderer/public/icon-512.png,
// generata da scripts/make-icon.mjs dal logo sorgente in logo/).
// Servita come asset statico: funziona in Electron, APK e client remoto.
export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <img
      src="./icon-512.png"
      width={size}
      height={size}
      alt="MasterHype"
      draggable={false}
      style={{ borderRadius: Math.round(size * 0.22), display: 'block', flexShrink: 0 }}
    />
  );
}
