BEGIN;

-- Block writes until cleanup and the unique index commit together. Lock the
-- referencing table too so no new method can point at a provider being removed.
LOCK TABLE "payment_provider", "payment_method" IN SHARE ROW EXCLUSIVE MODE;

-- Keep the oldest global provider, breaking timestamp ties by UUID. Preserve
-- that row's metadata and active state rather than silently merging settings.
CREATE TEMP TABLE "_global_payment_provider_duplicates" ON COMMIT DROP AS
SELECT "provider_id" AS "duplicate_id", "canonical_id"
FROM (
    SELECT "provider_id",
           FIRST_VALUE("provider_id") OVER (
               PARTITION BY "name", "type"
               ORDER BY "created_at", "provider_id"
           ) AS "canonical_id"
    FROM "payment_provider"
    WHERE "country_code" IS NULL
) AS "ranked"
WHERE "provider_id" <> "canonical_id";

-- Retain every payment method and its offer links; only change the provider FK.
UPDATE "payment_method" AS "method"
SET "provider_id" = "duplicate"."canonical_id"
FROM "_global_payment_provider_duplicates" AS "duplicate"
WHERE "method"."provider_id" = "duplicate"."duplicate_id";

DELETE FROM "payment_provider" AS "provider"
USING "_global_payment_provider_duplicates" AS "duplicate"
WHERE "provider"."provider_id" = "duplicate"."duplicate_id";

-- The existing three-column unique index still handles non-NULL countries.
-- This partial index supplies the missing uniqueness rule for global providers.
CREATE UNIQUE INDEX "payment_provider_global_name_type_unique"
ON "payment_provider" ("name", "type")
WHERE "country_code" IS NULL;

COMMIT;
