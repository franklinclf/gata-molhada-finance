-- What a registered income does when its day of the month is a weekend or a bank holiday: previous (the payment comes on the business day before), next (the one after) or keep. Existing rows get previous, how salaries are paid in Brazil.
ALTER TABLE income_items ADD COLUMN non_business_rule TEXT NOT NULL DEFAULT 'previous' CHECK (non_business_rule IN ('previous', 'next', 'keep'));
