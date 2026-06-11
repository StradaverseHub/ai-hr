-- Org catalog integrity: department/position/cost-center names were free text with no
-- uniqueness or normalization (dupes + whitespace variants fragment headcount, org chart and
-- cost allocation); company.country/currency drive pack lookup + holiday matching and were
-- unconstrained. Service layer normalizes going forward; these are the DB backstops.

-- Normalize existing rows so the indexes/checks can build.
UPDATE department SET name = btrim(regexp_replace(name, '\s+', ' ', 'g'));--> statement-breakpoint
UPDATE "position" SET title = btrim(regexp_replace(title, '\s+', ' ', 'g')), job_family = nullif(btrim(job_family), '');--> statement-breakpoint
UPDATE cost_center SET code = btrim(code), name = btrim(regexp_replace(name, '\s+', ' ', 'g'));--> statement-breakpoint
UPDATE company SET country = upper(btrim(country)), currency = upper(btrim(currency));--> statement-breakpoint

-- Case-insensitive uniqueness per company, ACTIVE rows only: an archived "Operations" does not
-- reserve the name; unarchiving into a live clash errors and is surfaced by the service layer.
CREATE UNIQUE INDEX department_company_name_uq ON department (company_id, lower(name)) WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX position_company_title_uq ON "position" (company_id, lower(title)) WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX cost_center_company_code_uq ON cost_center (company_id, lower(code)) WHERE archived_at IS NULL;--> statement-breakpoint

-- ISO shape: a company created as country "my" would match no holidays (raw equality) and
-- mis-group statutory filings. Uppercase 2-letter country / 3-letter currency, enforced.
ALTER TABLE company ADD CONSTRAINT company_country_iso2 CHECK (country ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE company ADD CONSTRAINT company_currency_iso3 CHECK (currency ~ '^[A-Z]{3}$');
