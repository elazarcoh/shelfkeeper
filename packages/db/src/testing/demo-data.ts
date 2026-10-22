/**
 * Fake household data for `pnpm dev:seed-demo` (and, later, e2e tests): a catalog of real, well-known
 * books with made-up copies, three people and ~18 months of reading history. Pure data — the seeding
 * (through the repositories) lives in demo-seed.ts.
 *
 * Dates are "days before today", so the history always ends today whenever it is seeded.
 */
import type { EditionFormat, EditionOwnership, FilterNode, GoalMetric, HoldingAction, ProgressKind, SessionMode, UserRole } from '@mylib/domain'

// ---- catalog --------------------------------------------------------------------------------

export interface DemoEdition {
  format: EditionFormat
  title?: string
  language?: string
  publisher?: string
  publishedOn?: string
  pageCount?: number
  wordCount?: number
  /** audiobooks: length in hours */
  hours?: number
  narrators?: string[]
  translators?: string[]
  shelfLocation?: string
  ownership?: EditionOwnership
  holdingNote?: string
  /** an ISBN-13 is made up for physical editions unless this is false */
  isbn?: boolean
  /** later holding changes, applied in order (days before today) */
  changes?: { action: HoldingAction; daysAgo: number; note?: string }[]
}

export interface DemoWork {
  key: string
  title: string
  subtitle?: string
  description?: string
  authors: string[]
  year?: number
  language?: string
  series?: { name: string; position: number | null; positionEnd?: number | null }
  tags?: string[]
  editions: DemoEdition[]
  /** when it entered the catalog (days before today); defaults to shortly before its first use */
  addedDaysAgo?: number
}

const SF = 'Science fiction'
const FANTASY = 'Fantasy'
const LIT = 'Literary fiction'
const NONFIC = 'Nonfiction'
const YA = 'Young adult'
const HEB = 'Hebrew'
const CLASSIC = 'Classics'

const phys = (pageCount: number, more: Omit<DemoEdition, 'format' | 'pageCount'> = {}): DemoEdition => ({ format: 'physical', pageCount, ...more })
const ebook = (wordCount: number, more: Omit<DemoEdition, 'format' | 'wordCount'> = {}): DemoEdition => ({ format: 'ebook', wordCount, ...more })
const audio = (hours: number, narrators: string[], more: Omit<DemoEdition, 'format' | 'hours' | 'narrators'> = {}): DemoEdition => ({ format: 'audiobook', hours, narrators, ...more })

const LIVING = 'Living room, shelf 2'
const STUDY = 'Study, top shelf'
const KIDS = "Ari's room"

export const DEMO_WORKS: DemoWork[] = [
  // Mistborn
  { key: 'final-empire', title: 'The Final Empire', authors: ['Brandon Sanderson'], year: 2006, language: 'en', series: { name: 'Mistborn', position: 1 }, tags: [FANTASY], editions: [phys(541, { publisher: 'Tor', shelfLocation: LIVING }), ebook(214_000)], description: 'For a thousand years the ash fell and no flowers bloomed. A crew of thieves plans the ultimate heist against a god-emperor.' },
  { key: 'well-of-ascension', title: 'The Well of Ascension', authors: ['Brandon Sanderson'], year: 2007, language: 'en', series: { name: 'Mistborn', position: 2 }, tags: [FANTASY], editions: [phys(590, { publisher: 'Tor', shelfLocation: LIVING })] },
  { key: 'hero-of-ages', title: 'The Hero of Ages', authors: ['Brandon Sanderson'], year: 2008, language: 'en', series: { name: 'Mistborn', position: 3 }, tags: [FANTASY], editions: [audio(27.5, ['Michael Kramer'])] },
  // Stormlight
  { key: 'way-of-kings', title: 'The Way of Kings', authors: ['Brandon Sanderson'], year: 2010, language: 'en', series: { name: 'The Stormlight Archive', position: 1 }, tags: [FANTASY, 'Epic'], editions: [audio(45.5, ['Michael Kramer', 'Kate Reading']), phys(1007, { publisher: 'Tor', shelfLocation: LIVING })] },
  { key: 'words-of-radiance', title: 'Words of Radiance', authors: ['Brandon Sanderson'], year: 2014, language: 'en', series: { name: 'The Stormlight Archive', position: 2 }, tags: [FANTASY, 'Epic'], editions: [audio(48, ['Michael Kramer', 'Kate Reading'])] },
  { key: 'oathbringer', title: 'Oathbringer', authors: ['Brandon Sanderson'], year: 2017, language: 'en', series: { name: 'The Stormlight Archive', position: 3 }, tags: [FANTASY, 'Epic'], editions: [phys(1243, { publisher: 'Tor', shelfLocation: LIVING }), ebook(451_000)] },
  { key: 'rhythm-of-war', title: 'Rhythm of War', authors: ['Brandon Sanderson'], year: 2020, language: 'en', series: { name: 'The Stormlight Archive', position: 4 }, tags: [FANTASY, 'Epic'], editions: [audio(57.5, ['Michael Kramer', 'Kate Reading'])] },
  // Harry Potter (one Hebrew translation as a second physical edition)
  { key: 'hp1', title: "Harry Potter and the Philosopher's Stone", authors: ['J. K. Rowling'], year: 1997, language: 'en', series: { name: 'Harry Potter', position: 1 }, tags: [FANTASY, YA], editions: [phys(223, { publisher: 'Bloomsbury', shelfLocation: KIDS }), audio(8.5, ['Jim Dale']), phys(270, { title: 'הארי פוטר ואבן החכמים', language: 'he', publisher: 'ידיעות ספרים', translators: ['גילי בר-הלל'], shelfLocation: KIDS })] },
  { key: 'hp2', title: 'Harry Potter and the Chamber of Secrets', authors: ['J. K. Rowling'], year: 1998, language: 'en', series: { name: 'Harry Potter', position: 2 }, tags: [FANTASY, YA], editions: [phys(251, { publisher: 'Bloomsbury', shelfLocation: KIDS })] },
  { key: 'hp3', title: 'Harry Potter and the Prisoner of Azkaban', authors: ['J. K. Rowling'], year: 1999, language: 'en', series: { name: 'Harry Potter', position: 3 }, tags: [FANTASY, YA], editions: [phys(317, { publisher: 'Bloomsbury', shelfLocation: KIDS })] },
  { key: 'hp4', title: 'Harry Potter and the Goblet of Fire', authors: ['J. K. Rowling'], year: 2000, language: 'en', series: { name: 'Harry Potter', position: 4 }, tags: [FANTASY, YA], editions: [phys(636, { publisher: 'Bloomsbury', shelfLocation: KIDS }), audio(20.75, ['Jim Dale'])] },
  // The Expanse
  { key: 'leviathan-wakes', title: 'Leviathan Wakes', authors: ['James S. A. Corey'], year: 2011, language: 'en', series: { name: 'The Expanse', position: 1 }, tags: [SF, 'Space opera'], editions: [phys(561, { publisher: 'Orbit', shelfLocation: STUDY })] },
  { key: 'calibans-war', title: "Caliban's War", authors: ['James S. A. Corey'], year: 2012, language: 'en', series: { name: 'The Expanse', position: 2 }, tags: [SF, 'Space opera'], editions: [phys(595, { publisher: 'Orbit', shelfLocation: STUDY })] },
  { key: 'abaddons-gate', title: "Abaddon's Gate", authors: ['James S. A. Corey'], year: 2013, language: 'en', series: { name: 'The Expanse', position: 3 }, tags: [SF, 'Space opera'], editions: [phys(539, { publisher: 'Orbit', shelfLocation: STUDY })], addedDaysAgo: 4 },
  // Dune
  { key: 'dune', title: 'Dune', authors: ['Frank Herbert'], year: 1965, language: 'en', series: { name: 'Dune', position: 1 }, tags: [SF, CLASSIC], editions: [phys(658, { publisher: 'Ace', shelfLocation: STUDY }), audio(21, ['Scott Brick', 'Orlagh Cassidy'])], description: 'Set on the desert planet Arrakis, Dune is the story of the boy Paul Atreides, heir to a noble family tasked with ruling an inhospitable world where the only thing of value is the "spice" melange.' },
  { key: 'dune-messiah', title: 'Dune Messiah', authors: ['Frank Herbert'], year: 1969, language: 'en', series: { name: 'Dune', position: 2 }, tags: [SF, CLASSIC], editions: [phys(336, { publisher: 'Ace', shelfLocation: STUDY })] },
  { key: 'children-of-dune', title: 'Children of Dune', authors: ['Frank Herbert'], year: 1976, language: 'en', series: { name: 'Dune', position: 3 }, tags: [SF, CLASSIC], editions: [phys(444, { publisher: 'Ace', shelfLocation: STUDY })] },
  // Discworld (gaps in the numbering on purpose)
  { key: 'guards-guards', title: 'Guards! Guards!', authors: ['Terry Pratchett'], year: 1989, language: 'en', series: { name: 'Discworld', position: 8 }, tags: [FANTASY, 'Humour'], editions: [phys(355, { publisher: 'Corgi', shelfLocation: LIVING })] },
  { key: 'small-gods', title: 'Small Gods', authors: ['Terry Pratchett'], year: 1992, language: 'en', series: { name: 'Discworld', position: 13 }, tags: [FANTASY, 'Humour'], editions: [phys(400, { publisher: 'Corgi', shelfLocation: LIVING })] },
  { key: 'men-at-arms', title: 'Men at Arms', authors: ['Terry Pratchett'], year: 1993, language: 'en', series: { name: 'Discworld', position: 15 }, tags: [FANTASY, 'Humour'], editions: [phys(384, { publisher: 'Corgi', shelfLocation: LIVING })] },
  // Murderbot
  { key: 'all-systems-red', title: 'All Systems Red', authors: ['Martha Wells'], year: 2017, language: 'en', series: { name: 'The Murderbot Diaries', position: 1 }, tags: [SF], editions: [ebook(31_000), audio(3.25, ['Kevin R. Free'])] },
  { key: 'artificial-condition', title: 'Artificial Condition', authors: ['Martha Wells'], year: 2018, language: 'en', series: { name: 'The Murderbot Diaries', position: 2 }, tags: [SF], editions: [ebook(33_000)] },
  { key: 'rogue-protocol', title: 'Rogue Protocol', authors: ['Martha Wells'], year: 2018, language: 'en', series: { name: 'The Murderbot Diaries', position: 3 }, tags: [SF], editions: [ebook(36_000)] },
  // Hitchhiker's
  { key: 'hitchhikers', title: "The Hitchhiker's Guide to the Galaxy", authors: ['Douglas Adams'], year: 1979, language: 'en', series: { name: "The Hitchhiker's Guide to the Galaxy", position: 1 }, tags: [SF, 'Humour', CLASSIC], editions: [audio(5.8, ['Stephen Fry']), phys(208, { publisher: 'Pan', shelfLocation: KIDS })] },
  { key: 'restaurant', title: 'The Restaurant at the End of the Universe', authors: ['Douglas Adams'], year: 1980, language: 'en', series: { name: "The Hitchhiker's Guide to the Galaxy", position: 2 }, tags: [SF, 'Humour'], editions: [audio(5.75, ['Stephen Fry'])] },
  // Earthsea
  { key: 'wizard-earthsea', title: 'A Wizard of Earthsea', authors: ['Ursula K. Le Guin'], year: 1968, language: 'en', series: { name: 'Earthsea', position: 1 }, tags: [FANTASY, CLASSIC], editions: [phys(183, { publisher: 'Puffin', shelfLocation: STUDY })] },
  { key: 'tombs-atuan', title: 'The Tombs of Atuan', authors: ['Ursula K. Le Guin'], year: 1970, language: 'en', series: { name: 'Earthsea', position: 2 }, tags: [FANTASY, CLASSIC], editions: [phys(163, { publisher: 'Puffin', shelfLocation: STUDY })] },
  // Remembrance of Earth's Past
  { key: 'three-body', title: 'The Three-Body Problem', authors: ['Liu Cixin'], year: 2008, language: 'en', series: { name: "Remembrance of Earth's Past", position: 1 }, tags: [SF], editions: [phys(400, { publisher: 'Tor', translators: ['Ken Liu'], shelfLocation: STUDY })] },
  { key: 'dark-forest', title: 'The Dark Forest', authors: ['Liu Cixin'], year: 2008, language: 'en', series: { name: "Remembrance of Earth's Past", position: 2 }, tags: [SF], editions: [audio(22.9, ['P. J. Ochlan'], { translators: ['Joel Martinsen'] })] },
  { key: 'deaths-end', title: "Death's End", authors: ['Liu Cixin'], year: 2010, language: 'en', series: { name: "Remembrance of Earth's Past", position: 3 }, tags: [SF], editions: [phys(604, { publisher: 'Tor', translators: ['Ken Liu'], shelfLocation: STUDY })] },
  // Middle-earth
  { key: 'hobbit', title: 'The Hobbit', subtitle: 'or There and Back Again', authors: ['J. R. R. Tolkien'], year: 1937, language: 'en', tags: [FANTASY, CLASSIC], editions: [phys(310, { publisher: 'HarperCollins', shelfLocation: LIVING })] },
  { key: 'fellowship', title: 'The Fellowship of the Ring', authors: ['J. R. R. Tolkien'], year: 1954, language: 'en', series: { name: 'The Lord of the Rings', position: 1 }, tags: [FANTASY, CLASSIC], editions: [phys(423, { publisher: 'HarperCollins', shelfLocation: LIVING }), audio(22.5, ['Andy Serkis'])] },
  { key: 'two-towers', title: 'The Two Towers', authors: ['J. R. R. Tolkien'], year: 1954, language: 'en', series: { name: 'The Lord of the Rings', position: 2 }, tags: [FANTASY, CLASSIC], editions: [phys(352, { publisher: 'HarperCollins', shelfLocation: LIVING })] },
  { key: 'return-king', title: 'The Return of the King', authors: ['J. R. R. Tolkien'], year: 1955, language: 'en', series: { name: 'The Lord of the Rings', position: 3 }, tags: [FANTASY, CLASSIC], editions: [phys(416, { publisher: 'HarperCollins', shelfLocation: LIVING })] },
  // Teen series
  { key: 'hunger-games', title: 'The Hunger Games', authors: ['Suzanne Collins'], year: 2008, language: 'en', series: { name: 'The Hunger Games', position: 1 }, tags: [YA, SF], editions: [phys(374, { publisher: 'Scholastic', shelfLocation: KIDS })] },
  { key: 'catching-fire', title: 'Catching Fire', authors: ['Suzanne Collins'], year: 2009, language: 'en', series: { name: 'The Hunger Games', position: 2 }, tags: [YA, SF], editions: [phys(391, { publisher: 'Scholastic', shelfLocation: KIDS })] },
  { key: 'lightning-thief', title: 'The Lightning Thief', authors: ['Rick Riordan'], year: 2005, language: 'en', series: { name: 'Percy Jackson and the Olympians', position: 1 }, tags: [YA, FANTASY], editions: [audio(10, ['Jesse Bernstein']), phys(377, { publisher: 'Disney Hyperion', shelfLocation: KIDS })] },
  { key: 'sea-of-monsters', title: 'The Sea of Monsters', authors: ['Rick Riordan'], year: 2006, language: 'en', series: { name: 'Percy Jackson and the Olympians', position: 2 }, tags: [YA, FANTASY], editions: [phys(279, { publisher: 'Disney Hyperion', shelfLocation: KIDS })] },
  { key: 'wonder', title: 'Wonder', authors: ['R. J. Palacio'], year: 2012, language: 'en', tags: [YA], editions: [phys(310, { publisher: 'Knopf', shelfLocation: KIDS })] },
  { key: 'alexander', title: 'Alexander and the Terrible, Horrible, No Good, Very Bad Day', authors: ['Judith Viorst'], year: 1972, language: 'en', tags: ["Children's"], editions: [phys(32, { publisher: 'Atheneum', shelfLocation: KIDS })] },
  // Standalone fiction
  { key: 'project-hail-mary', title: 'Project Hail Mary', authors: ['Andy Weir'], year: 2021, language: 'en', tags: [SF], editions: [audio(16.2, ['Ray Porter']), phys(476, { publisher: 'Ballantine', shelfLocation: STUDY })], description: 'Ryland Grace is the sole survivor on a desperate, last-chance mission — and if he fails, humanity and the earth itself will perish.' },
  { key: 'the-martian', title: 'The Martian', authors: ['Andy Weir'], year: 2011, language: 'en', tags: [SF], editions: [phys(369, { publisher: 'Crown', shelfLocation: STUDY, changes: [{ action: 'no_longer_have', daysAgo: 300, note: 'Lent to my brother, never came back' }, { action: 'got_back', daysAgo: 20, note: 'Found it at his place' }] })] },
  { key: 'klara', title: 'Klara and the Sun', authors: ['Kazuo Ishiguro'], year: 2021, language: 'en', tags: [LIT, SF], editions: [phys(303, { publisher: 'Faber & Faber', shelfLocation: LIVING })] },
  { key: 'never-let-me-go', title: 'Never Let Me Go', authors: ['Kazuo Ishiguro'], year: 2005, language: 'en', tags: [LIT], editions: [ebook(98_000)] },
  { key: 'remains-of-the-day', title: 'The Remains of the Day', authors: ['Kazuo Ishiguro'], year: 1989, language: 'en', tags: [LIT, CLASSIC], editions: [phys(258, { publisher: 'Vintage', shelfLocation: LIVING })] },
  { key: '1984', title: 'Nineteen Eighty-Four', authors: ['George Orwell'], year: 1949, language: 'en', tags: [CLASSIC, SF], editions: [phys(328, { publisher: 'Penguin', shelfLocation: STUDY })] },
  { key: 'animal-farm', title: 'Animal Farm', subtitle: 'A Fairy Story', authors: ['George Orwell'], year: 1945, language: 'en', tags: [CLASSIC], editions: [phys(112, { publisher: 'Penguin', changes: [{ action: 'no_longer_have', daysAgo: 150, note: 'Gave it to the school library' }] })] },
  { key: 'pride-prejudice', title: 'Pride and Prejudice', authors: ['Jane Austen'], year: 1813, language: 'en', tags: [CLASSIC, 'Romance'], editions: [phys(432, { publisher: 'Penguin Classics', shelfLocation: LIVING }), ebook(122_000)] },
  { key: 'circe', title: 'Circe', authors: ['Madeline Miller'], year: 2018, language: 'en', tags: [FANTASY, LIT, 'Mythology'], editions: [phys(393, { publisher: 'Little, Brown', shelfLocation: LIVING })] },
  { key: 'song-achilles', title: 'The Song of Achilles', authors: ['Madeline Miller'], year: 2011, language: 'en', tags: [LIT, 'Mythology'], editions: [ebook(105_000)] },
  { key: 'piranesi', title: 'Piranesi', authors: ['Susanna Clarke'], year: 2020, language: 'en', tags: [FANTASY, LIT], editions: [phys(272, { publisher: 'Bloomsbury', shelfLocation: LIVING })] },
  { key: 'midnight-library', title: 'The Midnight Library', authors: ['Matt Haig'], year: 2020, language: 'en', tags: [LIT], editions: [ebook(80_000)] },
  { key: 'good-omens', title: 'Good Omens', subtitle: 'The Nice and Accurate Prophecies of Agnes Nutter, Witch', authors: ['Terry Pratchett', 'Neil Gaiman'], year: 1990, language: 'en', tags: [FANTASY, 'Humour'], editions: [audio(12.6, ['Martin Jarvis'])] },
  { key: 'american-gods', title: 'American Gods', authors: ['Neil Gaiman'], year: 2001, language: 'en', tags: [FANTASY], editions: [phys(635, { publisher: 'William Morrow', shelfLocation: STUDY })] },
  { key: 'normal-people', title: 'Normal People', authors: ['Sally Rooney'], year: 2018, language: 'en', tags: [LIT, 'Romance'], editions: [phys(266, { publisher: 'Faber & Faber', shelfLocation: LIVING })] },
  { key: 'lessons-chemistry', title: 'Lessons in Chemistry', authors: ['Bonnie Garmus'], year: 2022, language: 'en', tags: [LIT], editions: [phys(390, { ownership: 'borrowed', holdingNote: 'Tel Aviv municipal library', isbn: false }), audio(11.9, ['Miranda Raison'])] },
  { key: 'tomorrow', title: 'Tomorrow, and Tomorrow, and Tomorrow', authors: ['Gabrielle Zevin'], year: 2022, language: 'en', tags: [LIT], editions: [phys(416, { ownership: 'borrowed', holdingNote: 'From Noa next door', isbn: false, changes: [{ action: 'returned', daysAgo: 225 }] })] },
  // Nonfiction
  { key: 'sapiens', title: 'Sapiens', subtitle: 'A Brief History of Humankind', authors: ['Yuval Noah Harari'], year: 2011, language: 'he', tags: [NONFIC, 'History'], editions: [phys(464, { title: 'קיצור תולדות האנושות', language: 'he', publisher: 'כנרת זמורה-ביתן', shelfLocation: STUDY }), ebook(152_000, { language: 'en' })] },
  { key: 'homo-deus', title: 'Homo Deus', subtitle: 'A Brief History of Tomorrow', authors: ['Yuval Noah Harari'], year: 2015, language: 'he', tags: [NONFIC], editions: [ebook(140_000, { language: 'en' })], addedDaysAgo: 2 },
  { key: 'thinking', title: 'Thinking, Fast and Slow', authors: ['Daniel Kahneman'], year: 2011, language: 'en', tags: [NONFIC, 'Psychology'], editions: [phys(499, { publisher: 'Farrar, Straus and Giroux', shelfLocation: STUDY })] },
  { key: 'educated', title: 'Educated', subtitle: 'A Memoir', authors: ['Tara Westover'], year: 2018, language: 'en', tags: [NONFIC, 'Memoir'], editions: [phys(334, { ownership: 'borrowed', holdingNote: 'From Maya’s sister', isbn: false, changes: [{ action: 'bought', daysAgo: 100, note: 'Loved it, bought our own copy' }] }), audio(12.1, ['Julia Whelan'])] },
  { key: 'atomic-habits', title: 'Atomic Habits', authors: ['James Clear'], year: 2018, language: 'en', tags: [NONFIC, 'Self-help'], editions: [audio(5.6, ['James Clear'])] },
  { key: 'pragmatic', title: 'The Pragmatic Programmer', subtitle: 'Your Journey to Mastery', authors: ['David Thomas', 'Andrew Hunt'], year: 1999, language: 'en', tags: [NONFIC, 'Programming'], editions: [ebook(120_000, { publisher: 'Addison-Wesley' }), phys(352, { publisher: 'Addison-Wesley', shelfLocation: STUDY })] },
  { key: 'feynman', title: "Surely You're Joking, Mr. Feynman!", subtitle: 'Adventures of a Curious Character', authors: ['Richard P. Feynman'], year: 1985, language: 'en', tags: [NONFIC, 'Memoir', 'Science'], editions: [audio(13.3, ['Raymond Todd'])] },
  { key: 'sacks', title: 'The Man Who Mistook His Wife for a Hat and Other Clinical Tales', authors: ['Oliver Sacks'], year: 1985, language: 'en', tags: [NONFIC, 'Science'], editions: [audio(9.5, ['Jonathan Davis'])] },
  // Hebrew
  { key: 'michael-sheli', title: 'מיכאל שלי', authors: ['עמוס עוז'], year: 1968, language: 'he', tags: [HEB, LIT], editions: [phys(248, { publisher: 'עם עובד', shelfLocation: LIVING })] },
  { key: 'sipur-ahava', title: 'סיפור על אהבה וחושך', authors: ['עמוס עוז'], year: 2002, language: 'he', tags: [HEB, 'Memoir'], editions: [phys(592, { publisher: 'כתר', shelfLocation: LIVING })] },
  { key: 'roman-rusi', title: 'רומן רוסי', authors: ['מאיר שלו'], year: 1988, language: 'he', tags: [HEB, LIT], editions: [phys(392, { publisher: 'עם עובד', shelfLocation: LIVING })] },
  { key: 'yona-vnaar', title: 'יונה ונער', authors: ['מאיר שלו'], year: 2006, language: 'he', tags: [HEB, LIT], editions: [ebook(130_000, { language: 'he' })] },
  { key: 'someone-to-run', title: 'מישהו לרוץ איתו', authors: ['דויד גרוסמן'], year: 2000, language: 'he', tags: [HEB, YA], editions: [phys(352, { publisher: 'הקיבוץ המאוחד', shelfLocation: LIVING })] },
  { key: 'horse-bar', title: 'סוס אחד נכנס לבר', authors: ['דויד גרוסמן'], year: 2014, language: 'he', tags: [HEB, LIT], editions: [phys(208, { publisher: 'הקיבוץ המאוחד', shelfLocation: LIVING })] },
  { key: 'tmol-shilshom', title: 'תמול שלשום', authors: ['ש"י עגנון'], year: 1945, language: 'he', tags: [HEB, CLASSIC], editions: [phys(608, { publisher: 'שוקן', shelfLocation: STUDY })] },
]

// ---- people ---------------------------------------------------------------------------------

/** The existing first admin; the demo members are created. `who` names them in the history below. */
export type DemoWho = 'admin' | 'partner' | 'teen'

export interface DemoMember {
  who: Exclude<DemoWho, 'admin'>
  username: string
  displayName: string
  role: UserRole
  /** dev-only credentials, printed by the seed */
  password: string
  pin: string
}

export const DEMO_MEMBERS: DemoMember[] = [
  { who: 'partner', username: 'maya', displayName: 'Maya', role: 'member', password: 'demo-maya-2026', pin: '1234' },
  { who: 'teen', username: 'ari', displayName: 'Ari', role: 'member', password: 'demo-ari-2026', pin: '2468' },
]

// ---- reading history ------------------------------------------------------------------------

/** A progress point (reading progress spec): `daysAgo` before today; added while the session is in progress. */
export interface DemoProgress {
  daysAgo: number
  kind: ProgressKind
  value: number
}

export interface DemoSession {
  book: string
  mode: SessionMode
  /** days before today */
  start: number
  /** days before today; absent = still in progress */
  end?: number
  abandonedAt?: number
  /** 'month' / 'year': an old read whose exact dates are not known */
  precision?: 'month' | 'year'
  /** which edition: the first of this format (and language) — defaults to the mode's format if the book has one */
  format?: EditionFormat
  language?: string
  /** progress points, oldest first */
  progress?: DemoProgress[]
}

const fin = (book: string, mode: SessionMode, start: number, end: number, more: Partial<DemoSession> = {}): DemoSession => ({ book, mode, start, end, ...more })
const quit = (book: string, mode: SessionMode, start: number, end: number, abandonedAt: number): DemoSession => ({ book, mode, start, end, abandonedAt })
const now = (book: string, mode: SessionMode, start: number, more: Partial<DemoSession> = {}): DemoSession => ({ book, mode, start, ...more })
const page = (daysAgo: number, value: number): DemoProgress => ({ daysAgo, kind: 'page', value })
const time = (daysAgo: number, hours: number): DemoProgress => ({ daysAgo, kind: 'seconds', value: Math.round(hours * 3600) })
const pct = (daysAgo: number, value: number): DemoProgress => ({ daysAgo, kind: 'percent', value })

export interface DemoHistory {
  sessions: DemoSession[]
  ratings: Record<string, number>
  reviews?: Record<string, string>
  /** status only, no session */
  wantToRead?: string[]
  /** read long ago, no session recorded */
  readLongAgo?: string[]
  /** "Up next", in order */
  queue: string[]
  /** added to their "My books" */
  myBooks: string[]
  goals: { metric: GoalMetric; target: number; period: 'this-year' | 'last-year' | 'this-month' }[]
}

export const DEMO_HISTORY: Record<DemoWho, DemoHistory> = {
  admin: {
    sessions: [
      fin('dune', 'read', 548, 518, { precision: 'month', format: 'physical' }),
      fin('final-empire', 'read', 540, 521, { format: 'physical' }),
      fin('1984', 'read', 530, 500, { precision: 'month' }),
      fin('well-of-ascension', 'read', 515, 489),
      fin('hero-of-ages', 'listen', 485, 461),
      fin('the-martian', 'read', 470, 462),
      fin('way-of-kings', 'listen', 450, 401),
      fin('leviathan-wakes', 'read', 420, 405),
      fin('animal-farm', 'read', 410, 405, { precision: 'year' }),
      fin('words-of-radiance', 'listen', 395, 351),
      fin('project-hail-mary', 'listen', 380, 371),
      fin('three-body', 'read', 360, 341),
      fin('oathbringer', 'read', 340, 299, { format: 'physical' }),
      fin('dark-forest', 'listen', 335, 309),
      fin('calibans-war', 'read', 300, 284),
      fin('sapiens', 'read', 280, 259, { format: 'physical', language: 'he' }),
      quit('thinking', 'read', 270, 238, 0.6),
      fin('dune-messiah', 'read', 250, 241),
      quit('children-of-dune', 'read', 230, 211, 0.4),
      fin('all-systems-red', 'read', 200, 198, { format: 'ebook' }),
      fin('artificial-condition', 'read', 196, 193),
      fin('pragmatic', 'read', 180, 158, { format: 'ebook' }),
      fin('feynman', 'listen', 170, 164),
      fin('hitchhikers', 'listen', 160, 157),
      fin('restaurant', 'listen', 156, 153),
      fin('sacks', 'listen', 140, 132),
      fin('piranesi', 'read', 130, 124),
      fin('klara', 'read', 120, 111),
      fin('educated', 'listen', 110, 103),
      fin('remains-of-the-day', 'read', 100, 92),
      fin('guards-guards', 'read', 90, 83),
      fin('men-at-arms', 'read', 80, 72),
      fin('good-omens', 'listen', 70, 63),
      fin('project-hail-mary', 'listen', 60, 51),
      fin('michael-sheli', 'read', 60, 49),
      fin('roman-rusi', 'read', 45, 29),
      quit('midnight-library', 'read', 40, 36, 0.25),
      fin('circe', 'read', 35, 27),
      fin('horse-bar', 'read', 25, 21, { progress: [page(24, 50), page(22, 130)] }),
      now('rhythm-of-war', 'listen', 20, { progress: [time(16, 7.5), time(9, 21), time(1, 31.25)] }),
      now('rogue-protocol', 'read', 14, { progress: [pct(10, 25), pct(3, 60)] }),
      now('small-gods', 'read', 5, { progress: [page(4, 48), page(2, 131), page(0, 182)] }),
      now('fellowship', 'listen', 3),
    ],
    ratings: {
      dune: 5, 'final-empire': 4.5, '1984': 4.5, 'well-of-ascension': 4, 'hero-of-ages': 5, 'the-martian': 4.5, 'way-of-kings': 5, 'leviathan-wakes': 4,
      'words-of-radiance': 5, 'project-hail-mary': 5, 'three-body': 4, oathbringer: 4.5, 'dark-forest': 4.5, 'calibans-war': 4, sapiens: 4, 'dune-messiah': 3.5,
      'children-of-dune': 2.5, 'all-systems-red': 4, 'artificial-condition': 4, pragmatic: 4.5, feynman: 5, hitchhikers: 4, restaurant: 3.5, sacks: 4,
      piranesi: 5, klara: 3.5, educated: 4.5, 'remains-of-the-day': 4.5, 'guards-guards': 4.5, 'men-at-arms': 4, 'good-omens': 4.5, 'michael-sheli': 4,
      'roman-rusi': 4.5, 'midnight-library': 2.5, circe: 4.5, 'horse-bar': 4, hobbit: 5, 'two-towers': 4.5, 'return-king': 5,
    },
    reviews: {
      'way-of-kings': 'Slow first half, then the last 200 pages are unbelievable. Kramer and Reading are perfect.',
      'children-of-dune': 'Stopped around the halfway mark. Might come back to it some day.',
      'roman-rusi': 'ספר מצחיק ועצוב בבת אחת. The English translation does not do it justice.',
    },
    wantToRead: ['abaddons-gate', 'deaths-end', 'homo-deus', 'tomorrow', 'american-gods'],
    readLongAgo: ['hobbit', 'two-towers', 'return-king'],
    queue: ['abaddons-gate', 'deaths-end', 'homo-deus', 'tomorrow'],
    myBooks: [
      'final-empire', 'well-of-ascension', 'hero-of-ages', 'way-of-kings', 'words-of-radiance', 'oathbringer', 'rhythm-of-war', 'leviathan-wakes', 'calibans-war',
      'abaddons-gate', 'dune', 'dune-messiah', 'children-of-dune', 'guards-guards', 'small-gods', 'men-at-arms', 'all-systems-red', 'artificial-condition',
      'rogue-protocol', 'hitchhikers', 'restaurant', 'wizard-earthsea', 'tombs-atuan', 'three-body', 'dark-forest', 'deaths-end', 'hobbit', 'fellowship',
      'two-towers', 'return-king', 'project-hail-mary', 'the-martian', 'remains-of-the-day', '1984', 'animal-farm', 'american-gods', 'sapiens', 'homo-deus',
      'thinking', 'pragmatic', 'feynman', 'sacks', 'michael-sheli', 'roman-rusi', 'horse-bar', 'tmol-shilshom', 'good-omens', 'klara', 'piranesi',
    ],
    goals: [
      { metric: 'books', target: 30, period: 'this-year' },
      { metric: 'hours', target: 150, period: 'this-year' },
      { metric: 'books', target: 24, period: 'last-year' },
    ],
  },
  partner: {
    sessions: [
      fin('circe', 'read', 400, 389),
      fin('song-achilles', 'read', 380, 371),
      fin('normal-people', 'read', 360, 354),
      fin('lessons-chemistry', 'listen', 300, 289),
      quit('tmol-shilshom', 'read', 260, 240, 0.2),
      fin('tomorrow', 'read', 250, 233),
      fin('pride-prejudice', 'read', 220, 204, { format: 'physical' }),
      fin('midnight-library', 'read', 200, 195),
      fin('klara', 'read', 180, 169),
      fin('never-let-me-go', 'read', 160, 150),
      quit('atomic-habits', 'listen', 140, 134, 0.5),
      fin('educated', 'read', 120, 109, { format: 'physical' }),
      fin('sipur-ahava', 'read', 100, 78),
      fin('someone-to-run', 'read', 70, 62),
      fin('piranesi', 'read', 40, 34),
      fin('project-hail-mary', 'listen', 30, 21),
      now('yona-vnaar', 'read', 18, { progress: [pct(12, 20), pct(4, 45)] }),
      now('the-martian', 'read', 8, { progress: [page(6, 70), page(1, 212)] }),
    ],
    ratings: {
      circe: 5, 'song-achilles': 5, 'normal-people': 3.5, 'lessons-chemistry': 4.5, 'tmol-shilshom': 2, tomorrow: 4.5, 'pride-prejudice': 5, 'midnight-library': 4,
      klara: 4, 'never-let-me-go': 4.5, 'atomic-habits': 3, educated: 5, 'sipur-ahava': 4.5, 'someone-to-run': 4, piranesi: 4.5, 'project-hail-mary': 5,
    },
    reviews: { circe: 'Gorgeous. Read it in three evenings.', 'sipur-ahava': 'ספר מטלטל. הפרקים על אמא שלו שברו לי את הלב.' },
    wantToRead: ['remains-of-the-day', 'thinking', 'hobbit'],
    queue: ['remains-of-the-day', 'thinking', 'hobbit'],
    myBooks: ['circe', 'song-achilles', 'normal-people', 'pride-prejudice', 'never-let-me-go', 'midnight-library', 'sipur-ahava', 'yona-vnaar', 'someone-to-run', 'educated', 'lessons-chemistry'],
    goals: [
      { metric: 'pages', target: 8000, period: 'this-year' },
      { metric: 'books', target: 4, period: 'this-month' },
    ],
  },
  teen: {
    sessions: [
      fin('hp1', 'read', 500, 489, { precision: 'month', format: 'physical', language: 'en' }),
      fin('hp2', 'read', 485, 477),
      fin('hp3', 'read', 470, 459),
      fin('hp4', 'read', 450, 428, { format: 'physical' }),
      fin('hunger-games', 'read', 380, 374),
      fin('catching-fire', 'read', 370, 361),
      fin('lightning-thief', 'listen', 300, 289),
      quit('sea-of-monsters', 'read', 280, 269, 0.35),
      fin('wonder', 'read', 250, 245),
      fin('hitchhikers', 'read', 200, 194, { format: 'physical' }),
      fin('all-systems-red', 'read', 100, 96, { format: 'ebook' }),
      fin('hp1', 'listen', 60, 49),
      now('hobbit', 'read', 30, { progress: [page(20, 95), page(9, 160), page(2, 140)] }),
    ],
    ratings: { hp1: 5, hp2: 5, hp3: 5, hp4: 4.5, 'hunger-games': 4.5, 'catching-fire': 4, 'lightning-thief': 4, 'sea-of-monsters': 3, wonder: 5, hitchhikers: 4, 'all-systems-red': 4.5 },
    wantToRead: ['dune', 'leviathan-wakes'],
    queue: ['dune', 'leviathan-wakes', 'catching-fire'],
    myBooks: ['hp1', 'hp2', 'hp3', 'hp4', 'hunger-games', 'catching-fire', 'lightning-thief', 'sea-of-monsters', 'wonder'],
    goals: [{ metric: 'books', target: 12, period: 'this-year' }],
  },
}

// ---- sets, hiding, loans --------------------------------------------------------------------

export const DEMO_FAMILY_SHELF = {
  name: 'Family shelf',
  books: ['hp1', 'hp2', 'hp3', 'hp4', 'hobbit', 'fellowship', 'two-towers', 'return-king', 'hitchhikers', 'wonder', 'alexander', 'lightning-thief', 'sea-of-monsters', 'hunger-games', 'catching-fire', 'pride-prejudice', '1984', 'animal-farm', 'wizard-earthsea', 'tombs-atuan'],
}
/** a global set hidden from the teen */
export const DEMO_GROWN_UP_SHELF = { name: 'Grown-up shelf', books: ['normal-people', 'lessons-chemistry', 'good-omens'] }
/** hidden from the teen on its own (not via a set) */
export const DEMO_HIDDEN_FROM_TEEN = 'american-gods'

export type DemoSmartSet =
  | { who: DemoWho | 'global'; name: string; filter: FilterNode }
  | { who: DemoWho | 'global'; name: string; tagFilter: { tags: string[]; notStatus: 'read' } }

export const DEMO_SMART_SETS: DemoSmartSet[] = [
  { who: 'global', name: 'Audiobooks', filter: { op: 'format', formats: ['audiobook'] } },
  { who: 'admin', name: 'Five stars', filter: { op: 'rating', min: 5, max: 5 } },
  { who: 'admin', name: 'Sci-fi I have not read', tagFilter: { tags: [SF], notStatus: 'read' } },
  { who: 'partner', name: 'בעברית', filter: { op: 'language', languages: ['he'] } },
]

export const DEMO_MANUAL_SETS: { who: Exclude<DemoWho, 'admin'> | 'admin'; name: string; books: string[] }[] = [
  { who: 'partner', name: 'Book club 2026', books: ['tomorrow', 'lessons-chemistry', 'piranesi', 'klara'] },
  { who: 'teen', name: 'Summer reading', books: ['hunger-games', 'catching-fire', 'hobbit', 'hitchhikers'] },
  { who: 'admin', name: 'To lend to Ari', books: ['dune', 'leviathan-wakes', 'wizard-earthsea'] },
]

export interface DemoLoan {
  book: string
  to: { who: DemoWho } | { name: string }
  lentDaysAgo: number
  dueDaysAgo?: number
  returnedDaysAgo?: number
}

export const DEMO_LOANS: DemoLoan[] = [
  { book: 'hobbit', to: { who: 'teen' }, lentDaysAgo: 31 },
  { book: 'project-hail-mary', to: { name: 'Uncle Moshe' }, lentDaysAgo: 60, dueDaysAgo: 20 },
  { book: 'circe', to: { name: 'Noa (next door)' }, lentDaysAgo: 25, dueDaysAgo: 5, returnedDaysAgo: 7 },
  { book: 'three-body', to: { name: 'Yoni from work' }, lentDaysAgo: 200, returnedDaysAgo: 150 },
  { book: 'the-martian', to: { who: 'partner' }, lentDaysAgo: 9, dueDaysAgo: -21 },
]

// ---- sources: Inbox proposals and a CSV import ------------------------------------------------

export interface DemoSourceItem {
  externalId: string
  format: EditionFormat
  title: string
  authors: string[]
  narrators?: string[]
  series?: { name: string; position: number | null; positionEnd?: number | null }[]
  durationSec?: number
  wantedOnly?: boolean
}

export const DEMO_ABS_ITEMS: DemoSourceItem[] = [
  { externalId: 'li_demo_abaddon', format: 'audiobook', title: "Abaddon's Gate", authors: ['James S. A. Corey'], narrators: ['Jefferson Mays'], series: [{ name: 'The Expanse', position: 3 }], durationSec: 19 * 3600 },
  { externalId: 'li_demo_final_empire', format: 'audiobook', title: 'The Final Empire', authors: ['Brandon Sanderson'], narrators: ['Michael Kramer'], series: [{ name: 'Mistborn', position: 1 }], durationSec: 24 * 3600 },
  { externalId: 'li_demo_tress', format: 'audiobook', title: 'Tress of the Emerald Sea', authors: ['Brandon Sanderson'], narrators: ['Michael Kramer'], durationSec: 13 * 3600 },
  { externalId: 'li_demo_ministry', format: 'audiobook', title: 'The Ministry for the Future', authors: ['Kim Stanley Robinson'], narrators: ['Jennifer Fitzgerald'], durationSec: 21 * 3600 },
  { externalId: 'li_demo_children_dune', format: 'ebook', title: 'Children of Dune', authors: ['Frank Herbert'], series: [{ name: 'Dune', position: 3 }] },
]

export const DEMO_READARR_ITEMS: DemoSourceItem[] = [
  { externalId: 'demo-wanted-wind', format: 'ebook', title: 'Wind and Truth', authors: ['Brandon Sanderson'], series: [{ name: 'The Stormlight Archive', position: 5 }], wantedOnly: true },
  { externalId: 'demo-wanted-leviathan-falls', format: 'ebook', title: 'Leviathan Falls', authors: ['James S. A. Corey'], series: [{ name: 'The Expanse', position: 9 }], wantedOnly: true },
  { externalId: 'demo-wanted-words', format: 'ebook', title: 'Words of Radiance', authors: ['Brandon Sanderson'], series: [{ name: 'The Stormlight Archive', position: 2 }], wantedOnly: true },
]
/** this wanted item is accepted as a new wanted book, so the catalog has one */
export const DEMO_ACCEPTED_WANTED = 'demo-wanted-wind'

/** A Goodreads-style export the partner imported (rows stay pending in her "Imports"). */
export const DEMO_CSV = {
  fileName: 'goodreads_library_export.csv',
  importId: '6f1c2a3e-8b4d-4c5e-9f60-7a8b9c0d1e2f',
  header: ['Title', 'Author', 'ISBN13', 'My Rating', 'Exclusive Shelf', 'Date Read', 'Number of Pages', 'Bookshelves'],
  rows: [
    ['Circe', 'Madeline Miller', '', '5', 'read', '2025/09/02', '393', 'mythology'],
    ['The Seven Husbands of Evelyn Hugo', 'Taylor Jenkins Reid', '', '4', 'read', '2024/07/14', '389', 'book-club'],
    ['Station Eleven', 'Emily St. John Mandel', '', '5', 'read', '2023/02/20', '333', 'science-fiction'],
    ['Where the Crawdads Sing', 'Delia Owens', '', '3', 'read', '2022/11/05', '384', ''],
    ['The Night Circus (The Night Circus, #1)', 'Erin Morgenstern', '', '0', 'to-read', '', '387', 'fantasy'],
    ['A Little Life', 'Hanya Yanagihara', '', '0', 'currently-reading', '', '720', ''],
  ],
}
