-- One pool per token, expressed correctly for both protocols.
--
-- 0001 created `CREATE UNIQUE INDEX tokens_by_pool ON tokens (pool_address)`,
-- which is exactly right for v3: every launch gets its own pool contract, so a
-- second token claiming the same pool address would be a bug worth rejecting.
--
-- It is wrong for v4, and 0005 did not notice. A v4 pool has no contract, so
-- every v4 row stores the PoolManager in pool_address — the same address for
-- every launch. The first v4 token inserted fine; the second violated the
-- constraint, which killed the whole index cycle on every pass rather than
-- just that row, so nothing at all was indexed afterwards.
--
-- The uniqueness that actually holds is per protocol: a v3 pool address is
-- unique, and a v4 pool id is unique. Both are expressed as partial indexes so
-- each still rejects a genuine duplicate.

BEGIN;

DROP INDEX IF EXISTS tokens_by_pool;

CREATE UNIQUE INDEX IF NOT EXISTS tokens_by_pool_v3
  ON tokens (pool_address)
  WHERE protocol = 'v3';

CREATE UNIQUE INDEX IF NOT EXISTS tokens_by_pool_id_unique
  ON tokens (pool_id)
  WHERE pool_id IS NOT NULL;

-- Superseded by the unique one above; keeping both would index the same column
-- twice for no benefit.
DROP INDEX IF EXISTS tokens_by_pool_id;

-- Lookups that do not care about protocol still want pool_address indexed, it
-- just must not be unique across both.
CREATE INDEX IF NOT EXISTS tokens_by_pool_address ON tokens (pool_address);

COMMIT;
