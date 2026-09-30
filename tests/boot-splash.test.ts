import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissSplash, failBoot, setBootStage } from '../src/renderer/src/bootSplash';

let classes: Set<string>;
let splash: { dataset: Record<string, string>; classList: { contains: (name: string) => boolean; add: (name: string) => void }; setAttribute: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let status: { textContent: string };
beforeEach(() => {
  vi.useFakeTimers();
  classes = new Set();
  splash = { dataset: {}, classList: { contains: (name) => classes.has(name), add: (name) => { classes.add(name); } }, setAttribute: vi.fn(), remove: vi.fn() };
  status = { textContent: '' };
  vi.stubGlobal('document', { getElementById: (id: string) => id === 'splash' ? splash : id === 'boot-status' ? status : null });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('boot splash lifecycle', () => {
  it('stays visible during a slow bootstrap, not just for a fixed duration', () => {
    setBootStage('Recupero le tue preferenze…');
    vi.advanceTimersByTime(5000);
    expect(status.textContent).toBe('Recupero le tue preferenze…');
    expect(classes.has('out')).toBe(false);
    expect(splash.remove).not.toHaveBeenCalled();
  });
  it('dismisses only when the renderer is ready and removes itself after the fade', () => {
    dismissSplash();
    expect(classes.has('out')).toBe(true);
    expect(splash.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
    expect(splash.remove).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(splash.remove).toHaveBeenCalledOnce();
  });
  it('is idempotent under React StrictMode', () => {
    dismissSplash(); dismissSplash();
    vi.runAllTimers();
    expect(splash.remove).toHaveBeenCalledOnce();
  });
  it('keeps a readable recovery screen on bootstrap failure', () => {
    failBoot();
    vi.runAllTimers();
    expect(splash.dataset.state).toBe('error');
    expect(status.textContent).toContain('Riprova');
    expect(splash.remove).not.toHaveBeenCalled();
  });
  it('tolerates missing splash markup', () => {
    vi.stubGlobal('document', { getElementById: () => null });
    expect(() => { setBootStage('Avvio…'); dismissSplash(); failBoot(); }).not.toThrow();
  });
});
