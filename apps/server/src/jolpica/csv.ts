import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

// A streaming reader for the Jolpica dump's CSV files (P3c, A§6.3): RFC 4180 as PostgreSQL `COPY … CSV HEADER`
// writes it. Comma separators, `"` quotes with `""` escapes, quoted newlines, LF or CRLF; an empty unquoted field is
// null, `""` an empty string. The dump is untrusted third-party data, so every limit stops the read with a fixed code
// and the file's base name, never its content.

/** About 4× the largest file of the 2026-10-27 dump (formula_one_lap.csv, 37 MB). */
/** The largest real file is 37 MB (lap, 2026-10-27; 172 MB peak RSS): raise this and the job's mem_limit together. */
export const MAX_FILE_BYTES = 64 * 1024 ** 2;
export const MAX_FIELD_CHARS = 64 * 1024;
export const MAX_COLUMNS = 64;

export type DumpCode =
  | 'missing'
  | 'not_file'
  | 'unreadable'
  | 'too_large'
  | 'field_cap'
  | 'column_cap'
  | 'bad_quote'
  | 'unterminated'
  | 'bad_record'
  | 'bad_header';

/** A dump that cannot be read: the job stops with `bad_dump`, this code and the file name. */
export class DumpError extends Error {
  readonly code: DumpCode;
  readonly file: string;
  constructor(code: DumpCode, file: string) {
    super(`${code} ${file}`);
    this.code = code;
    this.file = file;
  }
}

export type Caps = { fileBytes: number; fieldChars: number; columns: number };
const CAPS: Caps = { fileBytes: MAX_FILE_BYTES, fieldChars: MAX_FIELD_CHARS, columns: MAX_COLUMNS };
export type CsvRecord = Readonly<Record<string, string | null>>;

/**
 * The records of one file, keyed by header name; the header must name every one of `columns` (`bad_header`). The file
 * must be a regular file: it is opened without following a symlink (`not_file`) and without blocking on a FIFO, then
 * checked on the open handle.
 */
export async function* readCsv(
  path: string,
  columns: readonly string[] = [],
  caps: Caps = CAPS,
): AsyncGenerator<CsvRecord> {
  const file = basename(path);
  const fail = (code: DumpCode): never => {
    throw new DumpError(code, file);
  };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (err: NodeJS.ErrnoException) =>
      fail(err.code === 'ENOENT' ? 'missing' : err.code === 'ELOOP' ? 'not_file' : 'unreadable'),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('not_file');
    if (stat.size > caps.fileBytes) fail('too_large');

    let header: string[] | undefined;
    let record: (string | null)[] = [];
    let field = ''; // the current field so far: appended slice by slice (a rope in V8, linear)
    let quoted = false; // the current field started with a quote
    let inQuotes = false; // inside the quotes now
    let afterQuote = false; // a quote inside the quotes was just read: an escape or the closing quote
    let pendingCr = false; // a CR outside quotes, which must start a CRLF
    let bytes = 0;

    const endField = () => {
      if (record.length >= caps.columns) fail('column_cap');
      record.push(quoted || field !== '' ? field : null);
      field = '';
      quoted = false;
      afterQuote = false;
    };
    /** The finished record, or undefined for the header line. */
    const endRecord = (): CsvRecord | undefined => {
      endField();
      const values = record;
      record = [];
      if (header === undefined) {
        const names = values.map((v) => v ?? '');
        // `__proto__` as a key would set the record's prototype (N4).
        const bad = names.includes('') || names.includes('__proto__') || new Set(names).size !== names.length;
        if (bad || columns.some((c) => !names.includes(c))) fail('bad_header');
        header = names;
        return undefined;
      }
      if (values.length !== header.length) fail('bad_record');
      const out: Record<string, string | null> = {};
      for (const [i, name] of header.entries()) out[name] = values[i] ?? null;
      return out;
    };
    const add = (text: string) => {
      if (field.length + text.length > caps.fieldChars) fail('field_cap');
      field += text;
    };

    for await (const chunk of handle.createReadStream({ encoding: 'utf8', highWaterMark: 1 << 16, autoClose: false })) {
      const text = chunk as string;
      bytes += Buffer.byteLength(text);
      if (bytes > caps.fileBytes) fail('too_large'); // the file grew after the stat
      let start = 0; // the start of the run of plain characters not yet added to `field`
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (pendingCr) {
          if (c !== 10) fail('bad_record'); // a lone CR outside quotes
          pendingCr = false;
          start = i + 1;
          const out = endRecord();
          if (out) yield out;
          continue;
        }
        if (inQuotes) {
          if (c !== 34) continue;
          add(text.slice(start, i));
          start = i + 1;
          inQuotes = false;
          afterQuote = true;
          continue;
        }
        if (afterQuote) {
          // after a quote inside a quoted field: `""` is an escaped quote, else the field must end here
          if (c === 34) {
            add('"');
            inQuotes = true;
            afterQuote = false;
            start = i + 1;
            continue;
          }
          if (c !== 44 && c !== 10 && c !== 13) fail('bad_quote');
          afterQuote = false;
        }
        if (c === 44) {
          add(text.slice(start, i));
          endField();
          start = i + 1;
        } else if (c === 10 || c === 13) {
          add(text.slice(start, i));
          start = i + 1;
          if (c === 13) pendingCr = true;
          else {
            const out = endRecord();
            if (out) yield out;
          }
        } else if (c === 34) {
          if (field !== '' || quoted || i > start) fail('bad_quote'); // a quote inside an unquoted field
          quoted = true;
          inQuotes = true;
          start = i + 1;
        }
      }
      add(text.slice(start)); // the field goes on in the next chunk
    }
    if (inQuotes) fail('unterminated');
    if (pendingCr) fail('bad_record');
    // A last line without a newline still ends a record; an empty file has no header.
    if (field !== '' || quoted || record.length > 0) {
      const out = endRecord();
      if (out) yield out;
    }
    if (header === undefined) fail('bad_header');
  } finally {
    await handle.close();
  }
}
