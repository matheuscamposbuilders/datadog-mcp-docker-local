import { describe, expect, it } from 'vitest';
import { collectPages } from '../../src/http/paginate.js';
import type { Page } from '../../src/contracts.js';

describe('collectPages', () => {
  it('returns all items from a single page with no nextCursor', async () => {
    const fetchPage = async (): Promise<Page<number>> => Promise.resolve({ items: [1, 2, 3] });

    const result = await collectPages(fetchPage, { maxPages: 10, maxItems: 100 });

    expect(result).toEqual({ items: [1, 2, 3], truncated: false });
    expect(result.nextCursor).toBeUndefined();
  });

  it('follows cursors across several pages until the data runs out', async () => {
    const pages: Record<string, Page<number>> = {
      start: { items: [1, 2], nextCursor: 'p2' },
      p2: { items: [3, 4], nextCursor: 'p3' },
      p3: { items: [5] },
    };
    const calls: Array<string | undefined> = [];
    const fetchPage = async (cursor?: string): Promise<Page<number>> => {
      calls.push(cursor);
      const page = pages[cursor ?? 'start'];
      if (!page) throw new Error(`unexpected cursor: ${String(cursor)}`);
      return Promise.resolve(page);
    };

    const result = await collectPages(fetchPage, { maxPages: 10, maxItems: 100 });

    expect(result).toEqual({ items: [1, 2, 3, 4, 5], truncated: false });
    expect(calls).toEqual([undefined, 'p2', 'p3']);
  });

  it('stops after maxPages and reports truncated with the pending cursor', async () => {
    let callCount = 0;
    const fetchPage = async (cursor?: string): Promise<Page<number>> => {
      callCount += 1;
      const n = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      return Promise.resolve({ items: [n], nextCursor: String(n + 1) });
    };

    const result = await collectPages(fetchPage, { maxPages: 3, maxItems: 100 });

    expect(callCount).toBe(3);
    expect(result.items).toEqual([0, 1, 2]);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe('3');
  });

  it('cuts exactly at maxItems and preserves the current page nextCursor', async () => {
    const fetchPage = async (cursor?: string): Promise<Page<number>> => {
      if (cursor === undefined) {
        return Promise.resolve({ items: [1, 2, 3, 4, 5], nextCursor: 'page2' });
      }
      throw new Error('should not be called again once maxItems is reached mid-page');
    };

    const result = await collectPages(fetchPage, { maxPages: 100, maxItems: 3 });

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.items.length).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe('page2');
  });

  it('stops immediately when accumulated items already equal maxItems', async () => {
    const pages: Record<string, Page<number>> = {
      start: { items: [1, 2], nextCursor: 'p2' },
      p2: { items: [3, 4], nextCursor: 'p3' },
    };
    const fetchPage = async (cursor?: string): Promise<Page<number>> =>
      Promise.resolve(pages[cursor ?? 'start']!);

    const result = await collectPages(fetchPage, { maxPages: 100, maxItems: 4 });

    expect(result.items).toEqual([1, 2, 3, 4]);
    expect(result.items.length).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe('p3');
  });

  it('stops and marks truncated when fetchPage returns the same cursor it was called with', async () => {
    let callCount = 0;
    const fetchPage = async (cursor?: string): Promise<Page<number>> => {
      callCount += 1;
      if (cursor === undefined) {
        return Promise.resolve({ items: [1], nextCursor: 'stuck' });
      }
      // Buggy upstream: always hands back the same cursor it was given.
      return Promise.resolve({ items: [2], nextCursor: 'stuck' });
    };

    const result = await collectPages(fetchPage, { maxPages: 100, maxItems: 100 });

    // First call: cursor=undefined, nextCursor='stuck' -> not a repeat, continue.
    // Second call: cursor='stuck', nextCursor='stuck' -> repeat, stop.
    expect(callCount).toBe(2);
    expect(result.items).toEqual([1, 2]);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe('stuck');
  });

  it('does not loop forever when cursor repetition would otherwise be infinite', async () => {
    let callCount = 0;
    const fetchPage = async (cursor?: string): Promise<Page<number>> => {
      callCount += 1;
      if (callCount > 5) {
        throw new Error('collectPages did not stop on repeated cursor');
      }
      return Promise.resolve({ items: [callCount], nextCursor: cursor ?? 'loop' });
    };

    const result = await collectPages(fetchPage, { maxPages: 1000, maxItems: 1000 });

    expect(result.truncated).toBe(true);
  });
});
