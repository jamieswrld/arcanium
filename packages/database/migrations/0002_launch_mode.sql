-- Fee mode is chosen once, at launch, and never changes. Storing it alongside
-- the token means the website does not have to make two contract calls per
-- token (modeSet, then modeOf) just to render a badge on the listing.
--
-- NULL means the launch predates the mode distributor, which is different from
-- 0 (standard) and must stay distinguishable.

BEGIN;

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mode SMALLINT;

-- The listing sorts by these on every page load.
CREATE INDEX IF NOT EXISTS tokens_by_graduated ON tokens (graduated, launch_time DESC);
CREATE INDEX IF NOT EXISTS swaps_recent ON swaps (block_time DESC);

COMMIT;
