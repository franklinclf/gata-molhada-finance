-- The bill the card issuer put a charge on: the bill id once the charge is on a bill, and the due month the issuer expects
-- (YYYY-MM) while it is still pending. They place the charge exactly, where the date and the closing day only guess.
ALTER TABLE source_transactions ADD COLUMN bill_id TEXT;
ALTER TABLE source_transactions ADD COLUMN bill_forecast TEXT;

-- When the provider says the owner's consent for an institution ends, and when it will read the institution next.
ALTER TABLE freshness ADD COLUMN consent_expires_at TEXT;
ALTER TABLE freshness ADD COLUMN next_sync_at TEXT;
