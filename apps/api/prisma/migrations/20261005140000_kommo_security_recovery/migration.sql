-- FILE ONLY: no migration application authorized.
ALTER TABLE "KommoConnection" ADD COLUMN "allowedChannelRouteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "KommoWebhookEvent"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "results" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "KommoConversionDedupe"
  ADD COLUMN "publicationIntent" JSONB,
  ADD COLUMN "publicationStatus" TEXT NOT NULL DEFAULT 'materialized',
  ADD COLUMN "publicationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publicationNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "publicationLeaseToken" TEXT,
  ADD COLUMN "publicationLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "publicationErrorCode" TEXT;
CREATE INDEX "KommoConversionDedupe_publicationStatus_publicationNextAttemptAt_idx"
  ON "KommoConversionDedupe"("publicationStatus", "publicationNextAttemptAt");
ALTER TABLE "KommoWebhookEvent" ADD CONSTRAINT "KommoWebhookEvent_lease_pair"
  CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL));
ALTER TABLE "KommoConversionDedupe" ADD CONSTRAINT "KommoConversionDedupe_lease_pair"
  CHECK (("publicationLeaseToken" IS NULL) = ("publicationLeaseExpiresAt" IS NULL));
