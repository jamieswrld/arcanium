-- Which X account a handle-keyed vault belongs to.
--
-- Vaults are addressed by the lowercased handle, because resolving a handle to
-- X's permanent numeric id needs their paid tier and an unbuilt feature
-- protects nobody. The cost of that choice is that handles change hands: left
-- alone, whoever registers @alice after the original @alice abandons it would
-- inherit her fee stream.
--
-- This is the pin that closes it. The first account to claim a vault records
-- its numeric id here, and every later attestation for that handle must come
-- from the same id. A handle that changes hands after its owner has claimed
-- once is worth nothing to whoever takes it.
--
-- The window that remains is a handle abandoned before its owner ever claimed.
-- That is real and is documented rather than hidden.
--
-- Enforced by the attestation signer rather than by the vault contract, which
-- is where the trust already sits: the signer has always decided which wallet
-- a given identity maps to, and the documentation has always said so.

BEGIN;

CREATE TABLE IF NOT EXISTS x_vault_pins (
  -- The lowercased handle, which is what the vault address is derived from.
  handle        TEXT PRIMARY KEY CHECK (handle = lower(handle) AND handle ~ '^[a-z0-9_]{1,15}$'),
  -- X's permanent numeric id for the account that claimed it first.
  x_user_id     TEXT NOT NULL CHECK (x_user_id ~ '^[0-9]{1,25}$'),
  pinned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Kept for support questions: which wallet the first claim paid.
  first_recipient BYTEA CHECK (first_recipient IS NULL OR octet_length(first_recipient) = 20)
);

-- Answering "has this account taken any handle already" is a second lookup on
-- every attestation, so it gets an index rather than a scan.
CREATE INDEX IF NOT EXISTS x_vault_pins_by_user ON x_vault_pins (x_user_id);

COMMIT;
