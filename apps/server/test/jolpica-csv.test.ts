import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Caps, DumpError, readCsv } from '../src/jolpica/csv.ts';

const dir = mkdtempSync(join(tmpdir(), 'f1-jolpica-csv-'));
let n = 0;
const file = (content: string) => {
  const path = join(dir, `t${n++}.csv`);
  writeFileSync(path, content);
  return path;
};
const read = async (path: string, columns: string[] = [], caps?: Caps) => {
  const out = [];
  for await (const r of readCsv(path, columns, caps)) out.push(r);
  return out;
};
const fails = async (promise: Promise<unknown>, code: string, name: string) => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DumpError);
  expect(err).toMatchObject({ code, file: name, message: `${code} ${name}` });
};
const CAPS: Caps = { fileBytes: 1024, fieldChars: 8, columns: 3 };

describe('readCsv (PostgreSQL COPY … CSV HEADER)', () => {
  it('reads commas, doubled quotes and a newline inside quotes, by header name, CRLF', async () => {
    const path = file('id,name,note\r\n1,"a, b","say ""hi"""\r\n2,"two\r\nlines",x\r\n');
    expect(await read(path, ['id', 'note'])).toEqual([
      { id: '1', name: 'a, b', note: 'say "hi"' },
      { id: '2', name: 'two\r\nlines', note: 'x' },
    ]);
  });

  it('reads LF and a last line without a newline', async () => {
    expect(await read(file('a,b\n1,2\n3,4'))).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('an empty unquoted field is null, "" an empty string', async () => {
    expect(await read(file('a,b,c\r\n,"",\r\n'))).toEqual([{ a: null, b: '', c: null }]);
  });

  it('a header-only file has no records; an empty file has no header', async () => {
    expect(await read(file('a,b\r\n'), ['a'])).toEqual([]);
    const empty = file('');
    await fails(read(empty), 'bad_header', basename(empty));
  });

  it('records split across stream chunks read the same', async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => `${i},"q""${i}",\r\n`).join('');
    const got = await read(file(`id,v,e\r\n${rows}`));
    expect(got.length).toBe(30_000);
    expect(got[29_999]).toEqual({ id: '29999', v: 'q"29999', e: null });
  });

  it.each([
    ['an unterminated quote at the end', 'a,b\r\n1,"open\r\n', 'unterminated'],
    ['a quote inside an unquoted field', 'a,b\r\n1,x"y\r\n', 'bad_quote'],
    ['text after a closing quote', 'a,b\r\n1,"x"y\r\n', 'bad_quote'],
    ['a record with another column count', 'a,b\r\n1,2,3\r\n', 'bad_record'],
    ['a lone CR', 'a,b\r\n1,2\r3,4\r\n', 'bad_record'],
    ['a missing column', 'a,c\r\n1,2\r\n', 'bad_header'],
    ['a duplicate column', 'a,b,a\r\n1,2,3\r\n', 'bad_header'],
  ])('%s is bad_dump with a code and the file name only', async (_, content, code) => {
    const path = file(content);
    await fails(read(path, ['a', 'b']), code, basename(path));
  });

  it('caps a field, a record and a file, and never puts content in the error', async () => {
    const field = file('a\r\n123456789\r\n');
    await fails(read(field, [], CAPS), 'field_cap', basename(field));
    const quoted = file('a\r\n"1234""5678"\r\n'); // 9 characters once unescaped
    await fails(read(quoted, [], CAPS), 'field_cap', basename(quoted));
    const columns = file('a,b,c,d\r\n1,2,3,4\r\n');
    await fails(read(columns, [], CAPS), 'column_cap', basename(columns));
    const big = file(`a\r\n${'1\r\n'.repeat(400)}`);
    await fails(read(big, [], CAPS), 'too_large', basename(big));
    expect(await read(file('a,b,c\r\n12345678,,\r\n'), [], CAPS)).toEqual([{ a: '12345678', b: null, c: null }]);
  });

  it('refuses a symlink, a directory and a FIFO, and a missing file is missing', async () => {
    const target = file('a\r\n1\r\n');
    symlinkSync(target, join(dir, 'link.csv'));
    await fails(read(join(dir, 'link.csv')), 'not_file', 'link.csv');
    await fails(read(dir), 'not_file', basename(dir));
    execFileSync('mkfifo', [join(dir, 'fifo.csv')]);
    await fails(read(join(dir, 'fifo.csv')), 'not_file', 'fifo.csv');
    await fails(read(join(dir, 'nope.csv')), 'missing', 'nope.csv');
  });
});
