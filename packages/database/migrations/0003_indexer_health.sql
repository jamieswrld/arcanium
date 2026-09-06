-- Separate from 0002 because 0002 had already been applied by the time this was
-- needed, and the runner is forward-only: it records a filename and never looks
-- at that file again. Editing an applied migration is a silent no-op.

BEGIN;

-- One row per chain, rewritten every cycle. The website reads this to decide
-- whether to trust the database or fall back to reading the chain directly.
--
-- "Recent write" alone is not enough to answer that: during a backfill the
-- indexer writes constantly while still being millions of blocks behind. So the
-- distance from the tip is recorded too, and only a live *and* caught-up
-- indexer gets to serve the page.
CREATE TABLE IF NOT EXISTS indexer_health (
  chain_id       BIGINT PRIMARY KEY,
  tip_block      BIGINT NOT NULL,
  launches_block BIGINT NOT NULL,
  swaps_block    BIGINT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
