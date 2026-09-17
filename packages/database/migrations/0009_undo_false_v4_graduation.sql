-- Undo graduations that were never earned.
--
-- refreshPools read the quote reserve as `balanceOf(pool_address)`. For v3 that
-- is the pool's own contract and is correct. For v4 it is the shared
-- PoolManager, which holds every v4 market on the chain — so each v4 launch was
-- credited with the whole chain's liquidity, several million dollars of it, and
-- the same figure drives the graduation threshold. Every v4 token was therefore
-- marked graduated within a cycle of being created.
--
-- Graduation is meant to be permanent, and normally this table would be the
-- last place to rewrite history. That principle protects real graduations; it
-- does not oblige us to keep a badge that was awarded by a bug to markets
-- holding a few dollars. These tokens never crossed the threshold.
--
-- The stale reserve is zeroed too rather than left at its inflated value: the
-- indexer recomputes it properly on the next cycle, and until then zero is at
-- least not a claim that a new launch holds millions.

BEGIN;

UPDATE tokens
SET graduated = false, graduated_at = NULL
WHERE protocol = 'v4' AND graduated = true;

UPDATE token_stats
SET quote_balance = 0
WHERE token_address IN (SELECT token_address FROM tokens WHERE protocol = 'v4');

COMMIT;
