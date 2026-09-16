-- Uniswap v4 launches.
--
-- v4 has no per-pool contract. A pool is a key — currencies, fee, tick spacing
-- and hook — hashed into a 32-byte id, and every pool on the chain lives inside
-- one PoolManager. That breaks two assumptions baked into this schema:
--
--   1. pool_address is CHECK (octet_length = 20). A v4 pool id is 32 bytes and
--      cannot be stored there.
--   2. swaps were found by filtering logs on the pool's own address. In v4 the
--      emitter is always the PoolManager and the pool is topic 1, so the same
--      walk over one address serves every market at once.
--
-- Rather than widen pool_address and lose the guarantee that it is an address,
-- v4 rows keep the PoolManager in pool_address — which is truthfully the
-- contract hosting that market, and keeps "where does this trade" answerable
-- by every existing query — and carry the id separately.
--
-- protocol defaults to 'v3' so every existing row describes itself correctly
-- without a backfill.

BEGIN;

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'v3';
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pool_id BYTEA
  CHECK (pool_id IS NULL OR octet_length(pool_id) = 32);

-- A v4 launch has no NFT position: liquidity belongs to the launchpad contract
-- itself, which has no code to remove it. position_id is meaningless there, so
-- it must stop being NOT NULL rather than be filled with a lie.
ALTER TABLE tokens ALTER COLUMN position_id DROP NOT NULL;

ALTER TABLE tokens
  ADD CONSTRAINT tokens_protocol_shape CHECK (
    (protocol = 'v3' AND pool_id IS NULL AND position_id IS NOT NULL)
    OR (protocol = 'v4' AND pool_id IS NOT NULL)
  );

ALTER TABLE swaps ADD COLUMN IF NOT EXISTS pool_id BYTEA
  CHECK (pool_id IS NULL OR octet_length(pool_id) = 32);

-- The v4 swap walk reads one contract for every market, so the hot lookup is
-- id -> token rather than address -> token.
CREATE INDEX IF NOT EXISTS tokens_by_pool_id ON tokens (pool_id) WHERE pool_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS swaps_by_pool_id ON swaps (pool_id, block_time DESC) WHERE pool_id IS NOT NULL;

COMMIT;
