/**
 * Cursor-pagination helper shared by list/search tool handlers.
 *
 * `collectPages` knows nothing about Datadog's wire format — it drives an
 * injected `fetchPage` callback and enforces the limits the tool layer
 * hands it, including a loop-protection guard so a buggy upstream API
 * cannot hang the server forever.
 */
import type { Page } from '../contracts.js';

export interface PageLimits {
  readonly maxPages: number;
  readonly maxItems: number;
}

export interface CollectPagesResult<T> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
}

/**
 * Repeatedly calls `fetchPage(cursor)`, accumulating `items`, until one of:
 *   - the page returned has no `nextCursor` (natural end of data)
 *   - `limits.maxPages` pages have been fetched
 *   - accumulated items reach `limits.maxItems`
 *   - `fetchPage` returns the same cursor it was just called with (loop
 *     protection: a paginated API bug must not hang the server)
 *
 * `truncated` is `true` whenever the loop stopped for any reason other than
 * "no more data" — i.e. whenever a `nextCursor` was left on the table.
 */
export async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<Page<T>>,
  limits: PageLimits,
): Promise<CollectPagesResult<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  for (;;) {
    const page = await fetchPage(cursor);
    pageCount += 1;
    items.push(...page.items);

    if (page.nextCursor === undefined) {
      return { items, truncated: false };
    }

    // Loop protection: the upstream API handed back the exact cursor we
    // just fetched with. Treat that as "stuck" rather than looping forever.
    if (page.nextCursor === cursor) {
      return { items, nextCursor: page.nextCursor, truncated: true };
    }

    if (items.length >= limits.maxItems) {
      return { items: items.slice(0, limits.maxItems), nextCursor: page.nextCursor, truncated: true };
    }

    if (pageCount >= limits.maxPages) {
      return { items, nextCursor: page.nextCursor, truncated: true };
    }

    cursor = page.nextCursor;
  }
}
