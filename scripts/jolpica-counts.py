# P3c [box]: the Jolpica dump's own counts per year 1950-2017, from the documented import rules (A§6.3, A§7), for
# comparison with the database's (scripts/jolpica-facts.sql, section 1). Stdlib only and independent of the
# TypeScript importer: a rule that one of them gets wrong shows as a difference.
#
#   python3 -I scripts/jolpica-counts.py <dump csv dir>
#
# It reads local files only and prints counts only (tab-separated: year, then the counts), never a name or a time.
# The owner's machine or the VM only: it refuses under CI (A§12.1 invariant 3, the dump is never in CI).
#
# The rules, per round of a season with a year in 1950-2017:
#   races        the round's first R session (lowest id), when it has a timestamp
#   qualifyings  the round's Q1/Q2/Q3/QA/QB/QO sessions with entries, all with a timestamp, as one session, when one
#                of their entries has a position or a lap row with a time
#   race_entries the race's entries without status 40/41 (did not (pre-)qualify)
#   quali_entries the qualifying's entries, one per round entry (an entry without one counts alone)
#   laps         the race's lap rows, one per entry and lap number 1-32767 (a row without a number is a marker)
#   pits         the race's pit stops, one per entry and lap number 1-32767 through lap_id
import collections
import csv
import os
import sys

if os.environ.get('CI'):
    print('jolpica-counts refuses to run under CI', file=sys.stderr)
    sys.exit(2)
if len(sys.argv) != 2:
    print('usage: python3 -I scripts/jolpica-counts.py <dump csv dir>', file=sys.stderr)
    sys.exit(64)
DIR = sys.argv[1]
QUALI = {'Q1', 'Q2', 'Q3', 'QA', 'QB', 'QO'}
COLS = ['races', 'qualifyings', 'race_entries', 'quali_entries', 'laps', 'pits']


def rows(table):
    with open(os.path.join(DIR, f'formula_one_{table}.csv'), newline='', encoding='utf-8') as f:
        yield from csv.DictReader(f)


def number(v):
    return int(v) if v.isdigit() and 1 <= int(v) <= 32767 else None


year_of = {r['id']: int(r['year']) for r in rows('season') if r['year'].isdigit()}
round_year = {}
for r in rows('round'):
    y = year_of.get(r['season_id'])
    if y is not None and 1950 <= y <= 2017:
        round_year[r['id']] = y

races = {}  # round id -> its first R session row
parts = collections.defaultdict(list)  # round id -> its qualifying session rows
for s in rows('session'):
    if s['round_id'] not in round_year:
        continue
    if s['type'] == 'R':
        old = races.get(s['round_id'])
        if old is None or int(s['id']) < int(old['id']):
            races[s['round_id']] = s
    elif s['type'] in QUALI:
        parts[s['round_id']].append(s)

race_ids = {s['id'] for s in races.values() if s['timestamp'] != ''}
part_ids = {s['id'] for ps in parts.values() for s in ps}
entries = {}  # entry id -> row, for the races and every qualifying part
by_session = collections.defaultdict(list)
for e in rows('sessionentry'):
    if e['session_id'] in race_ids or e['session_id'] in part_ids:
        entries[e['id']] = e
        by_session[e['session_id']].append(e)

T = collections.defaultdict(collections.Counter)
year_of_session = {s['id']: round_year[r] for r, s in races.items()}
for sid in race_ids:
    T[year_of_session[sid]]['races'] += 1
    T[year_of_session[sid]]['race_entries'] += sum(e['status'] not in ('40', '41') for e in by_session[sid])

lap_number = {}  # lap id -> number, for the race laps (the pit stops' lap_id)
race_laps = set()  # (entry id, lap number)
timed_quali_entries = set()
for lap in rows('lap'):
    e = entries.get(lap['session_entry_id'])
    if e is None:
        continue
    if e['session_id'] in race_ids:
        lap_number[lap['id']] = number(lap['number'])
        if number(lap['number']) is not None:
            race_laps.add((e['id'], number(lap['number'])))
    elif lap['time'] != '':
        timed_quali_entries.add(e['id'])
for eid, _ in race_laps:
    T[year_of_session[entries[eid]['session_id']]]['laps'] += 1

stops = set()  # (entry id, lap number)
for p in rows('pitstop'):
    e = entries.get(p['session_entry_id'])
    n = lap_number.get(p['lap_id'])
    if e is not None and e['session_id'] in race_ids and n is not None:
        stops.add((e['id'], n))
for eid, _ in stops:
    T[year_of_session[entries[eid]['session_id']]]['pits'] += 1

for r, ps in parts.items():
    with_entries = [s for s in ps if by_session[s['id']]]
    es = [e for s in with_entries for e in by_session[s['id']]]
    if not es or any(s['timestamp'] == '' for s in with_entries):
        continue
    if not any(e['position'] != '' or e['id'] in timed_quali_entries for e in es):
        continue
    T[round_year[r]]['qualifyings'] += 1
    T[round_year[r]]['quali_entries'] += len({e['round_entry_id'] or 'e' + e['id'] for e in es})

print('\t'.join(['year', *COLS]))
total = collections.Counter()
for y in range(1950, 2018):
    print('\t'.join([str(y), *(str(T[y][c]) for c in COLS)]))
    total.update({c: T[y][c] for c in COLS})
print('\t'.join(['TOTAL', *(str(total[c]) for c in COLS)]))
