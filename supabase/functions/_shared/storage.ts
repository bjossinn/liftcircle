// Storage helpers (service role): list a folder recursively and remove everything in it.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** All object paths under `prefix` (no trailing slash), recursing into sub-folders. */
export async function listAllObjects(admin: SupabaseClient, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    if (!data?.length) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Folders are returned as entries without an id.
      if (entry.id === null || entry.id === undefined) out.push(...(await listAllObjects(admin, bucket, path)));
      else out.push(path);
    }
    if (data.length < pageSize) break;
  }
  return out;
}

/** Removes every object under `prefix`. Returns how many objects were removed. */
export async function removeFolder(admin: SupabaseClient, bucket: string, prefix: string): Promise<number> {
  const paths = await listAllObjects(admin, bucket, prefix);
  for (let i = 0; i < paths.length; i += 500) {
    const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 500));
    if (error) throw new Error(`remove from ${bucket}: ${error.message}`);
  }
  return paths.length;
}
