-- FILE ONLY: independent SQL review and real PostgreSQL validation required; do not apply.
ALTER TABLE "KommoConversionDedupe"
  ADD COLUMN "senderAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "senderRetryable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "senderLeaseToken" TEXT;

ALTER TABLE "KommoConversionDedupe"
  ADD CONSTRAINT "KommoConversionDedupe_sender_attempts_bound"
    CHECK ("senderAttempts" >= 0 AND "senderAttempts" <= 5),
  ADD CONSTRAINT "KommoConversionDedupe_sender_no_unproven_retry"
    CHECK ("senderRetryable" = false),
  ADD CONSTRAINT "KommoConversionDedupe_sender_claim_attempt"
    CHECK ("senderLeaseToken" IS NULL OR "senderAttempts" > 0);
