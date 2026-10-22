export type ConversionRecordErrorCode =
  | "ctwa_original_receipt_ambiguous"
  | "ctwa_destination_not_authorized"
  | "conversion_workspace_mismatch";

/** Typed refusal from recordExternalConversion. The message stays equal to the
 * code (as the previous plain Errors) so callers can map it to a persisted,
 * sanitized failure code instead of a generic "_unexpected". */
export class ConversionRecordError extends Error {
  constructor(readonly code: ConversionRecordErrorCode) {
    super(code);
    this.name = "ConversionRecordError";
  }
}
