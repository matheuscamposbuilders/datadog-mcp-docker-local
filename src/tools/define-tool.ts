/**
 * Identity helper used by every tool module in this directory when building
 * its exported `ToolDef` array.
 *
 * Why this exists (not obvious, don't "simplify" it away): assigning a
 * `ToolDef<S>` object literal directly into a variable/array typed
 * `readonly ToolDef[]` contextually types the literal against `ToolDef`'s
 * default generic `S = z.ZodObject`, which collapses that tool's
 * `handler`'s `args` parameter to an unhelpful generic shape instead of the
 * shape actually produced by its own `inputSchema`. Routing each literal
 * through this generic identity function first lets TypeScript infer `S`
 * from the literal's `inputSchema` field and correctly narrow `args` inside
 * that tool's own `handler`; only the final exported array widens back to
 * `ToolDef[]`, which is fine because by then each handler has already been
 * checked against its own schema.
 *
 * `src/contracts.ts` is frozen (see its header), so this helper cannot live
 * there — it stays here as the one shared copy every tool module imports,
 * instead of each module declaring an identical local copy.
 */
import * as z from 'zod/v4';
import type { ToolDef } from '../contracts.js';

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
