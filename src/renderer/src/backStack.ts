// Tasto indietro hardware (Android): i "layer" aperti sopra la schermata —
// lettore espanso, pannelli, dettagli artista, menu — si registrano qui e il
// top consuma il back. MainActivity invoca window.__mhBack() (definito in
// App.tsx): nessun consumatore → history delle schermate → poi sistema
// (history del browser/minimizza). Ritornare `false` NON è un errore.
//
// Uso nei componenti:
//   useEffect(() => isOpen ? pushBack(() => { close(); return true; }) : undefined, [isOpen]);
export type BackHandler = () => boolean; // true = evento consumato

declare global {
  interface Window {
    // MainActivity.onBackPressed lo invoca via evaluateJavascript.
    __mhBack?: () => boolean;
  }
}

const stack: BackHandler[] = [];

export function pushBack(h: BackHandler): () => void {
  stack.push(h);
  return () => {
    const i = stack.indexOf(h);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function handleBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]()) return true;
    } catch {
      stack.splice(i, 1); // handler rotto: lo si butta e si scende
    }
  }
  return false;
}
