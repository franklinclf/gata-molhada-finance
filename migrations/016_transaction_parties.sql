-- Who a Pix, TED or boleto came from and went to, and the card merchant code, as the sources report them. The document
-- (CPF or CNPJ) is never stored in full: only a hash to compare people and the last four digits to show.

ALTER TABLE source_transactions ADD COLUMN operation TEXT;
ALTER TABLE source_transactions ADD COLUMN mcc TEXT;
ALTER TABLE source_transactions ADD COLUMN payer_hash TEXT;
ALTER TABLE source_transactions ADD COLUMN payer_last4 TEXT;
ALTER TABLE source_transactions ADD COLUMN payer_name TEXT;
ALTER TABLE source_transactions ADD COLUMN receiver_hash TEXT;
ALTER TABLE source_transactions ADD COLUMN receiver_last4 TEXT;
ALTER TABLE source_transactions ADD COLUMN receiver_name TEXT;
