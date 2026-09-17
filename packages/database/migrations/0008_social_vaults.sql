-- Which social account a creator-fee vault address belongs to.
--
-- The vault address is a hash of `platform:handle`, and a hash does not run
-- backwards. So a token page holding only a fee-recipient address cannot say
-- whose it is — it can show 0x1bbd…2dA3 and nothing more, which tells a reader
-- nothing about who is actually being paid.
--
-- This records the pairing at the one moment both halves are known: when
-- somebody asks the API to derive a vault from a handle, which is exactly what
-- the launch form does before naming it as the recipient.
--
-- It is a convenience index, not a source of truth. The chain remains
-- authoritative about where fees go; this only lets the interface put a name
-- to an address it would otherwise render as hex. An address that is not in
-- here is displayed as an address rather than guessed at.

BEGIN;

CREATE TABLE IF NOT EXISTS social_vaults (
  vault_address BYTEA PRIMARY KEY CHECK (octet_length(vault_address) = 20),
  platform      TEXT NOT NULL CHECK (platform IN ('x', 'github')),
  handle        TEXT NOT NULL CHECK (handle = lower(handle)),
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Which vault does this handle have" is asked as often as the reverse.
CREATE INDEX IF NOT EXISTS social_vaults_by_handle ON social_vaults (platform, handle);

COMMIT;
