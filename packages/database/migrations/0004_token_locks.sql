-- Token locks created through ArcTokenLocker.
--
-- Mirrors the contract rather than deriving anything: the chain is the truth,
-- and this table exists so the site can answer "all locks", "locks for this
-- token", "locks I made" and "locks coming to me" without the browser walking
-- an ever-growing array.
--
-- Deliberately not stored: status. LOCKED / CLAIMABLE / CLAIMED is a function
-- of unlock_time, claimed_at and the current clock, so storing it would mean
-- a row that is wrong between the unlock second and whenever a job next ran.
-- It is computed at read time everywhere.

CREATE TABLE token_locks (
  chain_id       BIGINT  NOT NULL,
  lock_id        NUMERIC(78,0) NOT NULL,
  token_address  BYTEA   NOT NULL CHECK (octet_length(token_address) = 20),
  depositor      BYTEA   NOT NULL CHECK (octet_length(depositor) = 20),
  beneficiary    BYTEA   NOT NULL CHECK (octet_length(beneficiary) = 20),
  -- What the contract actually received, which for a fee-on-transfer token is
  -- less than what was requested. Never recompute this from the input amount.
  amount         NUMERIC(78,0) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  unlock_time    TIMESTAMPTZ NOT NULL,
  created_block  BIGINT  NOT NULL,
  created_tx     BYTEA   NOT NULL CHECK (octet_length(created_tx) = 32),
  claimed_at     TIMESTAMPTZ,
  claimed_block  BIGINT,
  claimed_tx     BYTEA CHECK (claimed_tx IS NULL OR octet_length(claimed_tx) = 32),
  PRIMARY KEY (chain_id, lock_id)
);

-- The three questions the UI asks, plus the token page's "is anything locked
-- in this token". All ordered by unlock_time because every list is either
-- "what matures next" or "what matured already".
CREATE INDEX token_locks_by_token       ON token_locks (chain_id, token_address, unlock_time);
CREATE INDEX token_locks_by_depositor   ON token_locks (chain_id, depositor, unlock_time DESC);
CREATE INDEX token_locks_by_beneficiary ON token_locks (chain_id, beneficiary, unlock_time DESC);
CREATE INDEX token_locks_recent         ON token_locks (chain_id, created_at DESC);

-- Unclaimed locks whose unlock has passed — the "Claimable" tab, which would
-- otherwise scan the whole table as the lock count grows.
CREATE INDEX token_locks_open ON token_locks (chain_id, unlock_time)
  WHERE claimed_at IS NULL;
