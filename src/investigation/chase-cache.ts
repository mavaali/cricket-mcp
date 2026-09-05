import type { InvestigationContext, Manifest } from './context.js';

/** One immutable scope per verified local context. Row and serialized-byte caps
 * bound retained data, not the JavaScript runtime's total heap/RSS. */
export const CHASE_CACHE_MAX_ROWS = 150_000;
export const CHASE_CACHE_MAX_BYTES = 192 * 1024 * 1024;
interface Value { rows: Record<string, unknown>[]; coverage: unknown }
const entries = new WeakMap<InvestigationContext, { key: string; value: Promise<Value> }>();
export async function cachedChase<T extends Value>(context: InvestigationContext, manifest: Manifest, scope: unknown, load: () => Promise<T>): Promise<T> {
  // In-memory/custom contexts cannot assert that their data is immutable.
  if (!context.cacheable) return load();
  const snapshot = await context.snapshot();
  if (snapshot.revision.status !== 'verified' || snapshot.manifest !== manifest) {
    entries.delete(context);
    return load();
  }
  const key = JSON.stringify([snapshot.revision.id, scope]);
  const previous = entries.get(context);
  if (previous?.key === key) return previous.value as Promise<T>;
  const entry = { key, value: Promise.resolve(null) as unknown as Promise<T> };
  entry.value = (async () => {
    try {
      const value = await load();
      const current = await context.snapshot();
      if (current.revision.status !== 'verified' || current.revision.id !== snapshot.revision.id || value.rows.length > CHASE_CACHE_MAX_ROWS || Buffer.byteLength(JSON.stringify(value)) > CHASE_CACHE_MAX_BYTES) {
        if (entries.get(context) === entry) entries.delete(context);
        return value;
      }
      for (const row of value.rows) Object.freeze(row);
      Object.freeze(value.rows);
      if (value.coverage && typeof value.coverage === 'object') {
        for (const item of Object.values(value.coverage)) if (item && typeof item === 'object') Object.freeze(item);
        Object.freeze(value.coverage);
      }
      Object.freeze(value);
      return value;
    } catch (error) {
      if (entries.get(context) === entry) entries.delete(context);
      throw error;
    }
  })();
  entries.set(context, entry);
  return entry.value;
}
