// A Map-backed CacheStorage for the service worker tests (#121). Keys are absolute URLs, the query included, as the
// Cache API keys them (no Vary: the worker's requests carry no header that varies). A hit is a fresh clone.

export const ORIGIN = 'https://f1.test';

const href = (key: Request | string) => new URL(typeof key === 'string' ? key : key.url, ORIGIN).href;

export class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(key: Request | string) {
    return this.entries.get(href(key))?.clone();
  }

  async put(key: Request | string, res: Response) {
    this.entries.set(href(key), res);
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }) as Request);
  }
}

export class FakeCaches {
  readonly byName = new Map<string, FakeCache>();

  async open(name: string) {
    const cache = this.byName.get(name) ?? new FakeCache();
    this.byName.set(name, cache);
    return cache;
  }

  async keys() {
    return [...this.byName.keys()];
  }

  async delete(name: string) {
    return this.byName.delete(name);
  }

  /** As the worker sees it: a real CacheStorage has more methods, which it never calls. */
  get storage() {
    return this as unknown as CacheStorage;
  }
}
