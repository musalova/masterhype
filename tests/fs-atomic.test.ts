import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, readJsonWithBackup, snapshotBackup } from '../src/main/fsAtomic';

const dir = () => mkdtempSync(join(tmpdir(), 'mh-atomic-'));

describe('scritture atomiche dei file di stato del PC', () => {
  it('sostituisce il contenuto senza lasciare file temporanei', () => {
    const d = dir();
    const f = join(d, 'settings.json');
    writeFileAtomic(f, '{"a":1}');
    writeFileAtomic(f, '{"a":2}');
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ a: 2 });
    expect(readdirSync(d)).toEqual(['settings.json']);
  });

  it('JSON troncato (blackout a metà scrittura) → ripiega sulla copia .bak', () => {
    const d = dir();
    const f = join(d, 'settings.json');
    writeFileAtomic(f, JSON.stringify({ libraryDir: 'D:\\Musica', remoteToken: 'abc' }));
    snapshotBackup(f); // ultimo avvio riuscito
    writeFileSync(f, '{"libraryDir": "D:\\\\Mus'); // file principale corrotto
    const r = readJsonWithBackup<{ libraryDir: string; remoteToken: string }>(f);
    expect(r?.fromBackup).toBe(true);
    expect(r?.value.remoteToken).toBe('abc');
  });

  it('file valido → letto direttamente; nessun file → null', () => {
    const d = dir();
    const f = join(d, 'x.json');
    expect(readJsonWithBackup(f)).toBeNull();
    writeFileAtomic(f, '[1,2]');
    expect(readJsonWithBackup<number[]>(f)).toEqual({ value: [1, 2], fromBackup: false });
    expect(existsSync(`${f}.bak`)).toBe(false);
  });

  it('principale e copia entrambi corrotti → null (il chiamante usa i default)', () => {
    const d = dir();
    const f = join(d, 'x.json');
    writeFileSync(f, '{nope');
    writeFileSync(`${f}.bak`, '{nope');
    expect(readJsonWithBackup(f)).toBeNull();
  });
});
