// The tyre compounds by season (#126, A§13): the feed's name → its class key (`cmp-<key>`, the fill `--<key>`), its
// words and its letter. In 2018 each name was one fixed compound with its own colour, seven dry steps from Hypersoft
// to Superhard; from 2019 Soft, Medium and Hard name the softest, middle and hardest of the weekend's three. The map is
// strict per season: a 2018-only name in a later session is unknown, as is any other name. Pirelli's test tyres (TEST,
// TEST_UNKNOWN) are named in every season and keep the grey fill of an unknown compound (there is no `cmp-test` rule).

export type Compound = {
  /** The class suffix and fill token: `cmp-<key>` and `--<key>`. */
  key: string;
  /** "Ultrasoft", "Test tyre": the start of a sentence; lower case it mid-sentence. */
  name: string;
  /** One or two letters for the dot and the stint bar: two where one would be ambiguous (SS, HS, US, SH). */
  letter: string;
};

const entry = (key: string, name: string, letter: string): Compound => ({ key, name, letter });

const WET_WEATHER: [string, Compound][] = [
  ['INTERMEDIATE', entry('intermediate', 'Intermediate', 'I')],
  ['WET', entry('wet', 'Wet', 'W')],
];
const TEST = entry('test', 'Test tyre', 'T');
const TESTS: [string, Compound][] = [
  ['TEST', TEST],
  ['TEST_UNKNOWN', TEST],
];

/** In legend order: softest to hardest, then the wet-weather tyres and the test tyre. */
const FROM_2019 = new Map<string, Compound>([
  ['SOFT', entry('soft', 'Soft', 'S')],
  ['MEDIUM', entry('medium', 'Medium', 'M')],
  ['HARD', entry('hard', 'Hard', 'H')],
  ...WET_WEATHER,
  ...TESTS,
]);

const SEASON_2018 = new Map<string, Compound>([
  ['HYPERSOFT', entry('hypersoft', 'Hypersoft', 'HS')],
  ['ULTRASOFT', entry('ultrasoft', 'Ultrasoft', 'US')],
  ['SUPERSOFT', entry('supersoft', 'Supersoft', 'SS')],
  ['SOFT', entry('soft-2018', 'Soft', 'S')],
  ['MEDIUM', entry('medium-2018', 'Medium', 'M')],
  ['HARD', entry('hard-2018', 'Hard', 'H')],
  ['SUPERHARD', entry('superhard', 'Superhard', 'SH')],
  ...WET_WEATHER,
  ...TESTS,
]);

/** A compound the season does not know, or none: the grey fill (no `cmp-unknown` rule) and `?`. */
export const UNKNOWN_COMPOUND: Compound = entry('unknown', 'Unknown compound', '?');

/** `meeting.year` picks the map; null (a player before its session detail arrives) is today's. */
const seasonOf = (year: number | null) => (year === 2018 ? SEASON_2018 : FROM_2019);

/** The feed's compound name in its season, or null for null or a name the season does not know. */
export const compoundOf = (feed: string | null, year: number | null): Compound | null =>
  (feed !== null && seasonOf(year).get(feed)) || null;

/** The season's compounds in legend order, each once. */
export const compoundsOf = (year: number | null): readonly Compound[] => [...new Set(seasonOf(year).values())];

/** The screen-reader words beside a dot: "ultrasoft tyres", "test tyres", "unknown tyres". */
export const tyresWords = (c: Compound | null): string =>
  c === null
    ? 'unknown tyres'
    : c.name.endsWith(' tyre')
      ? `${c.name.toLowerCase()}s`
      : `${c.name.toLowerCase()} tyres`;
