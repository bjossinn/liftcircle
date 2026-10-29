/**
 * One coaching relationship by id, from myRelationships(), with an account-scoped cached copy for
 * offline display (names / status only — the server re-checks every read and write).
 */
import { useCallback, useEffect, useState } from 'react';
import type { CoachingRelationship } from '@/backend/coachingContract';
import { coachingApi } from '@/backend/coaching';
import type { LiftDb } from '@/db/db';
import { coachingError } from '@/coaching/errors';

const key = (id: string) => `coach-rel:${id}`;

export function useRelationship(id: string, db: LiftDb, enabled: boolean) {
  const [rel, setRel] = useState<CoachingRelationship | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRel(undefined);
    db.kv
      .get(key(id))
      .then((row) => {
        if (cancelled || !row?.value) return;
        setRel((cur) => (cur === undefined ? (row.value as CoachingRelationship) : cur));
        setFromCache(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  const reload = useCallback(async () => {
    try {
      const all = await coachingApi.myRelationships();
      const found = all.find((r) => r.id === id) ?? null;
      setRel(found);
      setFromCache(false);
      setError(null);
      if (found) db.kv.put({ key: key(id), value: found }).catch(() => {});
      else db.kv.delete(key(id)).catch(() => {});
    } catch (e) {
      setError(coachingError(e, 'Couldn’t load this conversation.'));
    }
  }, [db, id]);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { rel, error, fromCache, reload };
}
