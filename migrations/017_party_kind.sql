-- Whether the other side of a payment is a person (CPF) or a company (CNPJ).

ALTER TABLE source_transactions ADD COLUMN payer_kind TEXT;
ALTER TABLE source_transactions ADD COLUMN receiver_kind TEXT;
