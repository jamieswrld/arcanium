-- Take back the graduations the v4 reserve bug handed out, now that the
-- reserves are measured properly.
--
-- 0009 already did this once, and it did not hold: it ran while the indexer
-- was still reading a v4 token's reserve as balanceOf(PoolManager) — the whole
-- chain's v4 liquidity — so the very next refresh cycle saw millions of
-- dollars against a $9,000 threshold and re-graduated all three tokens within
-- seconds. Undoing the symptom before fixing the cause only bought a cycle.
--
-- The cause is fixed now: the reserve comes from the pool's own liquidity and
-- price, and CEO reads $384 against the $9,000 target where it read $5.5M
-- before. So this correction can finally stick.
--
-- Unlike 0009 this does not clear every v4 graduation on sight. It clears a
-- graduation only where the reserve now on record does not support it, which
-- is the difference between correcting a bug and rewriting history: a market
-- that genuinely crossed the threshold keeps its badge, and graduation stays
-- the permanent, one-way fact it is meant to be. If all three tokens are
-- listed by the WHERE clause, that is because none of them ever crossed it.

BEGIN;

UPDATE tokens t
SET graduated = false, graduated_at = NULL
FROM token_stats s
WHERE s.token_address = t.token_address
  AND t.protocol = 'v4'
  AND t.graduated = true
  AND s.quote_balance < 9000000000;  -- $9,000 in 6-decimal USDC units

COMMIT;
