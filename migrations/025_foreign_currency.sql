-- A purchase made in another currency: the amount in that currency, for display. The transaction amount itself is the one
-- the bank charged in reais (Pluggy's amountInAccountCurrency), because the original amount is not reais.

ALTER TABLE source_transactions ADD COLUMN currency TEXT;
ALTER TABLE source_transactions ADD COLUMN foreign_amount INTEGER;
ALTER TABLE source_transactions ADD COLUMN foreign_converted INTEGER;
