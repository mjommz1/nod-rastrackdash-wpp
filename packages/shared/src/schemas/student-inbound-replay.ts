import { z } from "zod";

export const studentInboundReplayAuthorizeSchema = z
  .object({
    previewToken: z.string().min(1).max(200_000),
    confirmation: z.string().min(1).max(200),
    selection: z.enum(["canary_1", "remaining"]),
  })
  .strict();

export const studentInboundReplayItemStateSchema = z.enum([
  "pending",
  "processing",
  "failed",
  "delivered",
  "delivery_unknown",
]);
export const studentInboundReplayResultSchema = z.object({
  batchId: z.string(),
  selection: z.enum(["canary_1", "canary_5", "canary_10", "remaining"]),
  state: studentInboundReplayItemStateSchema,
  total: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      id: z.string(),
      state: studentInboundReplayItemStateSchema,
    }),
  ),
});
export const studentInboundReplayPreviewSchema = z.object({
  connectionId: z.string(),
  channelId: z.string(),
  eligible: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  scanLimit: z.number().int().positive(),
  batchLimit: z.literal(500),
  previewToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
  unavailableReason: z.string().nullable(),
  canSendRemaining: z.boolean(),
  latestBatch: studentInboundReplayResultSchema.nullable(),
});
export type StudentInboundReplayAuthorizeDto = z.infer<
  typeof studentInboundReplayAuthorizeSchema
>;
export type StudentInboundReplayPreviewDto = z.infer<
  typeof studentInboundReplayPreviewSchema
>;
export type StudentInboundReplayResultDto = z.infer<
  typeof studentInboundReplayResultSchema
>;
