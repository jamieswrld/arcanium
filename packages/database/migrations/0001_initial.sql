-- Arch initial schema. All monetary columns are NUMERIC(78,0) raw integer
-- units (wei-style); decimal conversion happens in application code with
-- bigint utilities, never floats. The chain is the source of truth: every
-- table here must be reconstructible from events.

BEGIN;

CREATE TYPE bridge_direction AS ENUM ('deposit', 'redeem');

CREATE TYPE bridge_action_state AS ENUM (
  'awaiting_source_transaction',
  'source_pending',
  'source_confirmed',
  'destination_submitted',
  'destination_confirmed',
  'completed',
  'failed_retryable',
  'failed_terminal',
  'reorg_detected',
  'paused'
);

-- One row per bridge action (deposit or redemption).
-- action_id = keccak256(abi.encode(sourceTxHash, logIndex)) — deterministic and
-- unique; the DB uniqueness plus on-chain processed sets prevent double
-- mint/release.
CREATE TABLE bridge_actions (
  action_id        BYTEA PRIMARY KEY CHECK (octet_length(action_id) = 32),
  direction        bridge_direction NOT NULL,
  state            bridge_action_state NOT NULL DEFAULT 'awaiting_source_transaction',
  source_chain_id  BIGINT NOT NULL,
  dest_chain_id    BIGINT NOT NULL,
  sender           BYTEA NOT NULL CHECK (octet_length(sender) = 20),
  recipient        BYTEA NOT NULL CHECK (octet_length(recipient) = 20),
  gross_amount     NUMERIC(78,0) NOT NULL CHECK (gross_amount >= 0),
  fee_amount       NUMERIC(78,0) NOT NULL CHECK (fee_amount >= 0),
  net_amount       NUMERIC(78,0) NOT NULL CHECK (net_amount >= 0),
  source_tx_hash   BYTEA CHECK (octet_length(source_tx_hash) = 32),
  source_log_index INTEGER,
  source_block     BIGINT,
  source_block_hash BYTEA CHECK (octet_length(source_block_hash) = 32),
  dest_tx_hash     BYTEA CHECK (octet_length(dest_tx_hash) = 32),
  dest_block       BIGINT,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (source_tx_hash, source_log_index)
);

CREATE INDEX bridge_actions_by_sender ON bridge_actions (sender, created_at DESC);
CREATE INDEX bridge_actions_by_recipient ON bridge_actions (recipient, created_at DESC);
CREATE INDEX bridge_actions_by_state ON bridge_actions (state) WHERE state NOT IN ('completed', 'failed_terminal');

-- Gas station quotes and drips.
CREATE TABLE gas_quotes (
  quote_id       UUID PRIMARY KEY,
  action_id      SMALLINT NOT NULL CHECK (action_id BETWEEN 0 AND 3),
  user_address   BYTEA NOT NULL CHECK (octet_length(user_address) = 20),
  native_out     NUMERIC(78,0) NOT NULL,
  ausd_in        NUMERIC(78,0) NOT NULL,
  network_fee    NUMERIC(78,0) NOT NULL,
  service_margin NUMERIC(78,0) NOT NULL,
  gas_price      NUMERIC(78,0) NOT NULL,
  chain_id       BIGINT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gas_drips (
  idempotency_key TEXT PRIMARY KEY,
  quote_id        UUID NOT NULL REFERENCES gas_quotes(quote_id),
  user_address    BYTEA NOT NULL CHECK (octet_length(user_address) = 20),
  status          TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
  tx_hash         BYTEA CHECK (octet_length(tx_hash) = 32),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX gas_drips_by_user ON gas_drips (user_address, created_at DESC);

-- Launched tokens.
CREATE TABLE tokens (
  token_address    BYTEA PRIMARY KEY CHECK (octet_length(token_address) = 20),
  chain_id         BIGINT NOT NULL,
  name             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  decimals         SMALLINT NOT NULL DEFAULT 18,
  creator          BYTEA NOT NULL CHECK (octet_length(creator) = 20),
  pair_token       BYTEA NOT NULL CHECK (octet_length(pair_token) = 20),
  pool_address     BYTEA NOT NULL CHECK (octet_length(pool_address) = 20),
  position_id      NUMERIC(78,0) NOT NULL,
  token_is_token0  BOOLEAN NOT NULL,
  metadata_uri     TEXT NOT NULL,
  image_url        TEXT,
  description      TEXT,
  website          TEXT,
  twitter          TEXT,
  telegram         TEXT,
  discord          TEXT,
  launch_block     BIGINT NOT NULL,
  launch_tx_hash   BYTEA NOT NULL CHECK (octet_length(launch_tx_hash) = 32),
  launch_time      TIMESTAMPTZ NOT NULL,
  graduated        BOOLEAN NOT NULL DEFAULT false,
  graduated_at     TIMESTAMPTZ,
  graduated_block  BIGINT,
  migration_state  TEXT NOT NULL DEFAULT 'none'
    CHECK (migration_state IN ('none', 'pending', 'migrated')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tokens_by_creator ON tokens (creator);
CREATE INDEX tokens_by_launch_time ON tokens (launch_time DESC);
CREATE UNIQUE INDEX tokens_by_pool ON tokens (pool_address);

-- Rolling market state per token (recomputed by the indexer; cache only).
CREATE TABLE token_stats (
  token_address     BYTEA PRIMARY KEY REFERENCES tokens(token_address),
  price_quote_x96   NUMERIC(78,0),          -- sqrtPriceX96 snapshot
  price_usd_e18     NUMERIC(78,0),          -- price in USD * 1e18, bigint math
  market_cap_usd_e6 NUMERIC(78,0),
  liquidity         NUMERIC(78,0),
  quote_balance     NUMERIC(78,0) NOT NULL DEFAULT 0,
  volume_24h_usd_e6 NUMERIC(78,0) NOT NULL DEFAULT 0,
  change_24h_bps    BIGINT,
  buy_count         BIGINT NOT NULL DEFAULT 0,
  sell_count        BIGINT NOT NULL DEFAULT 0,
  holder_count      BIGINT,
  tokens_burned     NUMERIC(78,0) NOT NULL DEFAULT 0,
  creator_rewards_accrued    NUMERIC(78,0) NOT NULL DEFAULT 0,
  creator_rewards_distributed NUMERIC(78,0) NOT NULL DEFAULT 0,
  protocol_revenue  NUMERIC(78,0) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw indexed swaps (source of candle truth).
CREATE TABLE swaps (
  chain_id      BIGINT NOT NULL,
  tx_hash       BYTEA NOT NULL CHECK (octet_length(tx_hash) = 32),
  log_index     INTEGER NOT NULL,
  pool_address  BYTEA NOT NULL CHECK (octet_length(pool_address) = 20),
  token_address BYTEA NOT NULL REFERENCES tokens(token_address),
  block_number  BIGINT NOT NULL,
  block_hash    BYTEA NOT NULL CHECK (octet_length(block_hash) = 32),
  block_time    TIMESTAMPTZ NOT NULL,
  sender        BYTEA NOT NULL CHECK (octet_length(sender) = 20),
  recipient     BYTEA NOT NULL CHECK (octet_length(recipient) = 20),
  amount_token  NUMERIC(78,0) NOT NULL,   -- signed: positive = pool received token
  amount_quote  NUMERIC(78,0) NOT NULL,   -- signed: positive = pool received quote
  sqrt_price_x96 NUMERIC(78,0) NOT NULL,
  liquidity     NUMERIC(78,0) NOT NULL,
  tick          INTEGER NOT NULL,
  is_buy        BOOLEAN NOT NULL,         -- user bought the launched token
  price_usd_e18 NUMERIC(78,0) NOT NULL,
  volume_usd_e6 NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX swaps_by_token_time ON swaps (token_address, block_time DESC);
CREATE INDEX swaps_by_block ON swaps (chain_id, block_number);

-- OHLCV candles. interval_seconds ∈ {60, 300, 900, 3600, 14400, 86400}.
CREATE TABLE candles (
  token_address    BYTEA NOT NULL REFERENCES tokens(token_address),
  interval_seconds INTEGER NOT NULL
    CHECK (interval_seconds IN (60, 300, 900, 3600, 14400, 86400)),
  bucket_start     TIMESTAMPTZ NOT NULL,
  open_usd_e18     NUMERIC(78,0) NOT NULL,
  high_usd_e18     NUMERIC(78,0) NOT NULL,
  low_usd_e18      NUMERIC(78,0) NOT NULL,
  close_usd_e18    NUMERIC(78,0) NOT NULL,
  volume_usd_e6    NUMERIC(78,0) NOT NULL DEFAULT 0,
  trade_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_address, interval_seconds, bucket_start)
);

-- Fee collection/distribution events.
CREATE TABLE fee_distributions (
  tx_hash          BYTEA NOT NULL CHECK (octet_length(tx_hash) = 32),
  log_index        INTEGER NOT NULL,
  token_address    BYTEA NOT NULL REFERENCES tokens(token_address),
  pair_token       BYTEA NOT NULL CHECK (octet_length(pair_token) = 20),
  token_fees_burned NUMERIC(78,0) NOT NULL,
  creator_reward   NUMERIC(78,0) NOT NULL,
  protocol_reward  NUMERIC(78,0) NOT NULL,
  block_number     BIGINT NOT NULL,
  block_time       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX fee_distributions_by_token ON fee_distributions (token_address, block_time DESC);

-- Best-effort holder balances (rebuilt from Transfer events).
CREATE TABLE holders (
  token_address BYTEA NOT NULL REFERENCES tokens(token_address),
  holder        BYTEA NOT NULL CHECK (octet_length(holder) = 20),
  balance       NUMERIC(78,0) NOT NULL,
  updated_block BIGINT NOT NULL,
  PRIMARY KEY (token_address, holder)
);

CREATE INDEX holders_by_balance ON holders (token_address, balance DESC);

-- Indexer cursors: one per (chain, stream). block_hash enables reorg detection.
CREATE TABLE indexer_cursors (
  chain_id    BIGINT NOT NULL,
  stream      TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash  BYTEA NOT NULL CHECK (octet_length(block_hash) = 32),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stream)
);

-- Append-only administrative audit log. No UPDATE/DELETE grants in production.
CREATE TABLE admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  payload     JSONB NOT NULL,
  evidence_tx BYTEA CHECK (octet_length(evidence_tx) = 32),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dead-letter records for worker jobs that exhausted retries.
CREATE TABLE dead_letters (
  id          BIGSERIAL PRIMARY KEY,
  queue       TEXT NOT NULL,
  job_id      TEXT NOT NULL,
  payload     JSONB NOT NULL,
  error       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution  TEXT,
  UNIQUE (queue, job_id)
);

COMMIT;
