// Sfondo ambientale "discoteca": orbe neon, forme geometriche wireframe,
// fari oscillanti e griglia synthwave. Tutto decorativo: pointer-events none,
// aria-hidden, e si spegne con prefers-reduced-motion (vedi index.css).
// Perf: i wrapper animano solo transform (compositing GPU); il blur vive
// sui figli statici, così il browser non ricalcola la sfocatura a ogni frame.
export default function Backdrop() {
  return (
    <div className="bgfx" aria-hidden="true">
      <div className="orb-wrap o1"><div className="orb" /></div>
      <div className="orb-wrap o2"><div className="orb" /></div>
      <div className="orb-wrap o3"><div className="orb" /></div>
      {/* Le forme wireframe (triangolo/quadrato/anello) sono state tolte: ai
          bordi della finestra apparivano come artefatti bianchi tagliati */}
      <div className="beam b1" />
      <div className="beam b2" />
      <div className="grid-floor" />
    </div>
  );
}
