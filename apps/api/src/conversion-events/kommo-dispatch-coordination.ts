import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

// One lock domain across processes, workspace swaps and Kommo dispatches.
// Acquire before connection/ledger locks. A collision only adds contention.
export async function lockKommoDispatch(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(
    Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext(${`client-swap:${workspaceId}`})) AS acquired`,
  );
  if (lock?.acquired !== true)
    throw new ConflictException("Workspace ocupado; tente novamente mais tarde");
}

export const KOMMO_DISPATCH_TRANSACTION_MS = 5000;
// Leave transaction-lifetime headroom. Check at the actual synchronous fetch
// boundary, so a paused/expired callback cannot invoke the provider later.
export const KOMMO_DISPATCH_START_MS = 2000;
export const KOMMO_NETWORK_MS = 10000;
