import { describe, it, expect } from 'vitest';
import { junkArtist, junkTitle } from '../src/shared/taste';

describe('junkArtist — canali-compilation riconosciuti', () => {
  const junk = ['Sonami_production', 'Fresh Beatz', 'Reggaeton Latino', "Don's Tunes",
    'Classical Music for Brain Power', 'THE GYM BEATS', 'Jazz and Blues Experience',
    'AI-Music', 'LUNA ITALIANA', 'Male singer with guitar', 'Group of singers with guitar',
    'Lofi Fruits Music', 'alexrainbirdMusic', 'OSOCITYNATION', 'Latino Mix',
    'Nabis Lyrics', 'Slow Acoustic', 'Synthwave Nation', 'The Big 80s Guys', '𝘀𝗮𝗱 𝘁𝗵𝗶𝗻𝗴𝘀',
    'Highway Roots Music', 'Cafe Music', 'Hot Beat Universe', 'Flashback Grooves',
    'Songholics', 'Aloha Vibes', 'Soul Vinyl Lounge'];
  // Canali ambigui a livello artista (parola a rischio falso positivo) ma i cui
  // upload muoiono comunque sul titolo:
  for (const [a, t] of [['Motown Legend', 'Best Motown Hits of All Time'],
    ['Beach Bossa Deluxe', 'Beach Bossa Nova Classics'],
    ['Morning Serenity', 'Peaceful Chill Playlist'],
    ['Lumosound', '3 Hours of Chill Lofi Music']])
    it(`${a} → titolo junk`, () => expect(junkTitle(t)).toBe(true));
  for (const a of junk) it(a, () => expect(junkArtist(a)).toBe(true));
});

describe('junkArtist — artisti veri NON toccati', () => {
  const real = ['John Legend', 'Central Cee', 'Fleet Foxes', 'Massive Attack', 'The Beat',
    'Culture Club', 'Panic! at the Disco', 'Mix Master Mike', '2Pac', '50 Cent', '808 State',
    'blink-182', 'Sfera Ebbasta', 'Vasco Rossi', 'Bruno Mars', 'The Jimi Hendrix Experience',
    'Tokyo Ska Paradise', 'Bossa Nostra', 'Vintage Trouble', 'Sleep', 'Peder B. Helland',
    'Stereo MCs', 'The Sounds', 'Third World', 'Sujan Chapagain', 'P. Lion', 'Trallallera',
    'HAIM', 'Coldplay', 'Musiq Soulchild', 'Radiohead', 'Portishead', 'Tom Jobim'];
  for (const a of real) it(a, () => expect(junkArtist(a)).toBe(false));
});

describe('junkTitle — compilation/megamix riconosciuti', () => {
  const junk = ['75 Timeless Jazz Classics', 'Best of 80s RETROWAVE Mix Vol. 2',
    'Spotify Pop Hits 2026', '1 Hour of Island Chill', 'Most Viral Phonk/Funk 2026 🎵',
    'The Best Bossa Nova Songs | Brazilian Music', 'Mix Reggaeton 2025', 'Chill Lofi Beats',
    'Workout Music 2025 💪', 'le più belle canzoni italiane', 'Party Songs Mix Reggaeton 🎶',
    '50 Most Famous Classical Music Masterpieces', 'Relax Getaway - Acoustic Guitar',
    'Romantic Songs That Touch the Heart 💖 Best Love Songs 2026'];
  for (const t of junk) it(t, () => expect(junkTitle(t)).toBe(true));
});

describe('junkTitle — suffissi "(…)" da compilation/mixtape', () => {
  // Leak reali dalla stazione "techno": la guardia "(Extended Mix) ok"
  // lasciava passare anche i suffissi da upload da canale.
  const junk = ['Techno Nun 3 (Rave Techno Mix)', 'Energy Flow (DJ Mix)',
    'Warehouse (Continuous Mix)', 'Main Stage (Festival Mix)', 'Deep Cut (Bootleg)',
    'Anthem (Live Set)', 'Intro (In The Mix)', 'Night Drive (Minimix)', 'Setlist Part 1',
    'The Podcast Ep. 12', 'Live Set 2025'];
  for (const t of junk) it(t, () => expect(junkTitle(t)).toBe(true));
});

describe('junkTitle — suffissi release legittimi NON toccati', () => {
  const real = ['Song (Extended Mix)', 'Track (Club Mix)', 'Hit (Festival Remix)',
    'Bassline (Dub Mix)', 'Original (Radio Mix)', 'Move (VIP Mix)', 'Night (Remix)',
    'After Hours', 'Song (After Hours Remix)', 'Rave', 'Carnival (Festival Edit)'];
  for (const t of real) it(t, () => expect(junkTitle(t)).toBe(false));
});

describe('junkTitle — titoli veri NON toccati', () => {
  const real = ['Relax', 'The Best', 'Uptown Funk', 'Good Vibes', 'Love Song', 'September',
    'Take Five', 'Sweet Dreams (Are Made of This)', 'A Bar Song (Tipsy)',
    'Prayer in C (Robin Schulz Radio Edit)', 'In Da Club', 'Music', 'Work', 'Clair De Lune',
    'Party Rock Anthem', 'Stairway to Heaven', 'Shine On You Crazy Diamond'];
  for (const t of real) it(t, () => expect(junkTitle(t)).toBe(false));
});
