export function setBootStage(label: string): void {
  const status = document.getElementById('boot-status');
  if (status) status.textContent = label;
}

export function dismissSplash(): void {
  const splash = document.getElementById('splash');
  if (!splash || splash.classList.contains('out')) return;
  splash.setAttribute('aria-hidden', 'true');
  splash.classList.add('out');
  setTimeout(() => splash.remove(), 320);
}

export function failBoot(): void {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.dataset.state = 'error';
  setBootStage('Non riesco ad aprire l’app. Riprova a caricare.');
}
