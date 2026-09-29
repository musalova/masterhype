import { describe, it, expect } from 'vitest';
import {
  normText, normTag, trackKey, baseTitleOf, trackBaseKey,
  signalWeight, listenTasteWeight, LISTEN_COMPLETE_WEIGHT, TAG_SPILL,
} from '../src/shared/taste';

// Vettori golden dei normalizzatori e dei pesi condivisi (shared/taste.ts) —
// unica fonte usata da main (engine/library/recommend) e renderer
// (localData/offlineRec/store). Se qualcuno cambia una regex o un peso,
// questi test bloccano la derive su ENTRAMBI i lati contemporaneamente.

describe('normText — forma canonica confronti', () => {
  it('diacritici, punteggiatura e case collassano', () => {
    expect(normText('Måneskin')).toBe('maneskin');
    expect(normText('AC/DC')).toBe('acdc'); // punteggiatura rimossa (non spaziata)
    expect(normText('  Jóhann   Jóhannsson ')).toBe('johann johannsson');
    expect(normText('Beyoncé')).toBe('beyonce');
    expect(normText('')).toBe('');
  });
});

describe('chiavi brano', () => {
  it('trackKey: esatta — feat./remaster restano nel titolo', () => {
    expect(trackKey('X', 'Song (feat. Y)')).toBe('x|song feat y');
    expect(trackKey('X', 'Song')).not.toBe(trackKey('X', 'Song (feat. Y)'));
    expect(trackKey('Måneskin', 'Coraline')).toBe(trackKey('MANESKIN', 'Coraline'));
  });
  it('trackBaseKey: fuzzy — versioni alternative = stesso brano', () => {
    expect(trackBaseKey('X', 'Song (Remastered)')).toBe(trackBaseKey('X', 'Song'));
    expect(trackBaseKey('X', 'Song [Live]')).toBe(trackBaseKey('X', 'Song'));
    expect(trackBaseKey('X', 'Song - Remastered 2011')).toBe(trackBaseKey('X', 'Song'));
    expect(trackBaseKey('X', 'Song - Acoustic')).toBe(trackBaseKey('X', 'Song'));
    // ...ma un titolo diverso non collassa
    expect(trackBaseKey('X', 'Song')).not.toBe(trackBaseKey('X', 'Other'));
    expect(trackBaseKey('Y', 'Song')).not.toBe(trackBaseKey('X', 'Song'));
  });
  it('baseTitleOf: le parentesi e i suffissi di versione spariscono', () => {
    expect(baseTitleOf('Song (Deluxe Edition)')).toBe('song');
    expect(baseTitleOf('Song - Radio Edit')).toBe('song');
  });
});

describe('normTag — generi', () => {
  it('separatori e punteggiatura diventano spazi', () => {
    expect(normTag('Hip-Hop')).toBe('hip hop');
    expect(normTag('R&B')).toBe('r b');
    expect(normTag('  synth-pop!! ')).toBe('synth pop');
  });
});

describe('pesi dei segnali — tabella unica PC/telefono', () => {
  it('valori canonici', () => {
    expect(signalWeight('like')).toBe(3);
    expect(signalWeight('download')).toBe(2.5);
    expect(signalWeight('burn')).toBe(2);
    expect(signalWeight('play')).toBe(1);
    expect(signalWeight('skip')).toBe(-1);
    expect(signalWeight('hide')).toBe(-2);
    expect(signalWeight('unlike')).toBe(-3);
    expect(signalWeight('sconosciuto')).toBe(0);
    expect(TAG_SPILL).toBe(0.35);
  });
  it('completamento ascolto = regola del server', () => {
    // ≥85% della durata → +1.2 (mezzo like); parziale → evento ma gusto 0
    expect(listenTasteWeight(170, 200)).toBe(LISTEN_COMPLETE_WEIGHT); // 85%
    expect(listenTasteWeight(169, 200)).toBe(0);                      // 84.5%
    expect(listenTasteWeight(240)).toBe(LISTEN_COMPLETE_WEIGHT);      // ≥4min senza durata
    expect(listenTasteWeight(239)).toBe(0);
    expect(listenTasteWeight(60, 0)).toBe(0);                         // durata 0 = ignota
  });
});
