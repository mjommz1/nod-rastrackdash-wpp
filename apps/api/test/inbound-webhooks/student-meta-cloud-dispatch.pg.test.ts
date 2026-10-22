import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";
import { MetaConnectionResolverService } from "../../src/integrations/meta/meta-connection-resolver.service";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import {
  studentReplayContext,
  studentReplayEventHash,
} from "../../src/inbound-webhook-replay/student-replay-context";

// Parent-run only. Never read DATABASE_URL, create services/schema or call Meta.
// Requires an empty disposable DB provisioned with the CURRENT Prisma schema.
const optedIn =
  process.env.NOD_META_DISPATCH_PG_OPT_IN === "disposable-local-only";
function disposableUrl(): string {
  const raw = process.env.NOD_META_DISPATCH_TEST_PG_URL;
  if (!raw) throw new Error("Dedicated disposable PG test URL required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid disposable PG test URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/nod_meta_dispatch_test_[a-z0-9_]+$/.test(url.pathname) ||
    [...url.searchParams.keys()].some(
      (k) => !["schema", "connection_limit", "pool_timeout"].includes(k),
    ) ||
    (url.searchParams.get("schema") ?? "public") !== "public"
  )
    throw new Error(
      "PG harness requires a loopback disposable nod_meta_dispatch_test_* database",
    );
  return raw;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Disposable PG race gate timed out")),
          3000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function raceTasks() {
  const tasks: Promise<unknown>[] = [];
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // Observe immediately, including between awaited race boundaries. The same
  // rejection is still propagated by wait(); cleanup only drains pending work.
  void failure.catch(() => undefined);
  return {
    track<T>(task: Promise<T>): Promise<T> {
      tasks.push(task);
      void task.catch(rejectFailure);
      return task;
    },
    wait<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, failure]);
    },
    settle: () => Promise.allSettled(tasks),
  };
}
const ack = () =>
  new Response(
    JSON.stringify({
      events_received: 1,
      messages: [],
      fbtrace_id: "synthetic",
    }),
    { status: 200 },
  );
const env = {
  API_PUBLIC_URL: "https://local.example.invalid",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_REPLAY_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  META_APP_SECRET: "synthetic-signing-only",
  META_TOKEN_ENCRYPTION_KEY: "synthetic-encryption-only",
  LICENSE_SERVER_URL: "https://synthetic-license.example.invalid",
};
const encryption = new MetaTokenEncryptionService(env);

// Only scheduling instrumentation; reads, transactions, PK conflicts and locks
// go to the actual PrismaClient/PostgreSQL. No stateful persistence mock here.
function scheduledClient(
  db: PrismaClient,
  gate: (sql: string) => Promise<void>,
) {
  return new Proxy(db, {
    get(target, key) {
      if (key === "$transaction")
        return (
          fn: (tx: Prisma.TransactionClient) => unknown,
          options: unknown,
        ) =>
          target.$transaction(
            async (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, k) {
                    if (k === "$queryRaw")
                      return async (query: any, ...values: any[]) => {
                        const sql = query.sql ?? query.join?.("") ?? "";
                        await gate(sql);
                        return (t.$queryRaw as any)(query, ...values);
                      };
                    const value = Reflect.get(t, k);
                    return typeof value === "function" ? value.bind(t) : value;
                  },
                }),
              ),
            options as any,
          );
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.skipIf(!optedIn)(
  "real disposable PostgreSQL Meta Cloud dispatch linearization",
  () => {
    let db: PrismaClient;
    let mutator: PrismaClient;
    let observer: PrismaClient;
    beforeAll(async () => {
      const url = disposableUrl();
      db = new PrismaClient({ datasources: { db: { url } } });
      mutator = new PrismaClient({ datasources: { db: { url } } });
      observer = new PrismaClient({ datasources: { db: { url } } });
      try {
        await db.$connect();
        // Reject populated DBs before any seed/mutation. Parent owns disposal.
        if ((await db.workspace.count()) || (await db.user.count()))
          throw new Error("nonempty");
      } catch {
        throw new Error(
          "Disposable DB unavailable, nonempty, or current Prisma schema missing; URL withheld",
        );
      }
    });
    afterAll(async () => {
      await Promise.all(
        [db, mutator, observer].filter(Boolean).map((p) => p.$disconnect()),
      );
    });

    async function fixture(
      gate: (sql: string) => Promise<void> = async () => undefined,
      finalLicenseGate: () => Promise<void> = async () => undefined,
    ) {
      await db.licenseState.upsert({
        where: { id: "singleton" },
        create: {
          id: "singleton",
          fingerprint: "synthetic",
          accountIdentity: "synthetic",
          licenseKeyPrefix: "synthetic",
          status: "active",
          cacheValidUntil: new Date(Date.now() + 86400000),
          lastCheckedAt: new Date(),
        },
        update: {
          status: "active",
          cacheValidUntil: new Date(Date.now() + 86400000),
          lastCheckedAt: new Date(),
        },
      });
      const id = randomUUID();
      const user = await db.user.create({
        data: { email: `synthetic-${id}@example.invalid` },
      });
      const workspace = await db.workspace.create({
        data: { name: "Disposable test", slug: `dispatch-${id}` },
      });
      const ws = workspace.id;
      const owner = await db.workspaceMember.create({
        data: { workspaceId: ws, userId: user.id, role: "owner" },
      });
      const release = await db.inboundWebhookParserRelease.upsert({
        where: { provider_version: { provider: "meta_cloud", version: "v1" } },
        create: { provider: "meta_cloud", version: "v1", status: "certified" },
        update: {},
      });
      const credential = await db.metaCredential.create({
        data: {
          workspaceId: ws,
          source: "manual",
          label: "Synthetic",
          status: "active",
          ...encryption.encrypt("synthetic-original-token"),
          fingerprint: "synthetic-original",
          tokenLast4: "test",
          scopes: [],
        },
      });
      const destination = await db.metaConversionDestination.create({
        data: {
          workspaceId: ws,
          pixelId: "synthetic-pixel",
          pageId: "synthetic-page",
          pixelName: "Synthetic",
          pageName: "Synthetic",
        },
      });
      const business = await db.metaBusinessConnection.create({
        data: {
          workspaceId: ws,
          credentialId: credential.id,
          businessManagerId: "synthetic-bm",
          businessManagerName: "Synthetic",
          status: "active",
          defaultConversionDestinationId: destination.id,
        },
      });
      const account = await db.metaReportingAccount.create({
        data: {
          workspaceId: ws,
          businessId: "synthetic-bm",
          businessName: "Synthetic",
          adAccountId: "synthetic-account",
          adAccountName: "Synthetic",
          businessConnectionId: business.id,
          conversionDestinationId: destination.id,
        },
      });
      await db.metaReportingAccountDestination.create({
        data: {
          workspaceId: ws,
          reportingAccountId: account.id,
          conversionDestinationId: destination.id,
        },
      });
      await db.metaAd.create({
        data: {
          workspaceId: ws,
          adId: "synthetic-ad",
          campaignId: "synthetic-campaign",
          adSetId: "synthetic-set",
          adAccountId: account.adAccountId,
          name: "Synthetic",
        },
      });
      const connection = await db.inboundWebhookConnection.create({
        data: {
          workspaceId: ws,
          provider: "meta_cloud",
          parserReleaseId: release.id,
          displayName: "Synthetic",
        },
      });
      const channel = await db.inboundWebhookChannel.create({
        data: {
          workspaceId: ws,
          connectionId: connection.id,
          organizationId: "synthetic-org",
          providerChannelId: "synthetic-channel",
          connectedPhone: "15550000001",
          status: "active",
        },
      });
      const route = await db.inboundWebhookChannelRoute.create({
        data: {
          workspaceId: ws,
          channelId: channel.id,
          routeKey: "synthetic",
          validationStatus: "valid",
          metaBusinessConnectionWorkspaceId: ws,
          metaBusinessConnectionId: business.id,
          metaConversionDestinationWorkspaceId: ws,
          metaConversionDestinationId: destination.id,
        },
      });
      const delivery = await db.inboundWebhookDelivery.create({
        data: {
          workspaceId: ws,
          connectionId: connection.id,
          provider: "meta_cloud",
          parserVersion: "v1",
          ingressKey: "synthetic",
          firstReceivedAt: new Date(Date.now() - 120000),
          payloadExpiresAt: new Date(Date.now() + 86400000),
          encryptedPayload: "synthetic-unread-payload",
        },
      });
      const event = await db.inboundWebhookEvent.create({
        data: {
          workspaceId: ws,
          connectionId: connection.id,
          channelId: channel.id,
          deliveryId: delivery.id,
          provider: "meta_cloud",
          dedupeKey: "synthetic-event",
          occurredAt: new Date(Date.now() - 60000),
          hasCtwa: true,
          adId: "synthetic-ad",
          classification: "eligible_route_resolved",
          normalizedSummary: {},
          resolvedBusinessConnectionWorkspaceId: ws,
          resolvedBusinessConnectionId: business.id,
          resolvedReportingAccountWorkspaceId: ws,
          resolvedReportingAccountId: account.id,
          resolvedConversionDestinationWorkspaceId: ws,
          resolvedConversionDestinationId: destination.id,
        },
      });
      const log = await db.conversionEventLog.create({
        data: {
          workspaceId: ws,
          sourceTrigger: "inbound_webhook:meta_cloud",
          status: "ready_to_send",
          eventName: "LeadSubmitted",
          eventId: `synthetic-${id}`,
          dedupeKey: `inbound-webhook:${connection.id}:${event.dedupeKey}`,
          phoneHash: "a".repeat(64),
          ctwaClid: "synthetic-click",
          adId: event.adId,
          eventOccurredAt: event.occurredAt,
          metaAccountId: account.adAccountId,
          metaBusinessConnectionId: business.id,
          metaConversionDestinationId: destination.id,
          sourcePayload: { inboundEventId: event.id },
        },
      });
      const batch = await db.inboundWebhookReplayBatch.create({
        data: {
          workspaceId: ws,
          connectionId: connection.id,
          channelId: channel.id,
          requestedByUserId: user.id,
          status: "completed",
          totalItems: 1,
          materializedCount: 1,
        },
      });
      await db.inboundWebhookReplayItem.create({
        data: {
          workspaceId: ws,
          batchId: batch.id,
          eventId: event.id,
          status: "materialized",
          conversionEventLogId: log.id,
        },
      });
      const snapshot = await db.inboundWebhookEvent.findUniqueOrThrow({
        where: { id: event.id },
        include: { delivery: true },
      });
      const context = await studentReplayContext(
        db,
        ws,
        connection.id,
        channel.id,
      );
      expect(context).toBeTruthy();
      await db.auditLog.create({
        data: {
          workspaceId: ws,
          actorUserId: user.id,
          actorType: "user",
          action: "inbound_webhook.replay.authorize",
          targetType: "InboundWebhookReplayBatch",
          targetId: batch.id,
          resultStatus: "authorized",
          afterSummary: {
            studentContext: context,
            studentEventHashes: {
              [event.id]: studentReplayEventHash(snapshot),
            },
          },
        },
      });
      const fetcher = vi.fn<typeof fetch>(async () => ack());
      let finalLocksAcquired = false;
      let lockedLicenseReads = 0;
      const client = scheduledClient(db, async (sql) => {
        await gate(sql);
        if (sql.includes('FROM "AuditLog"') && sql.includes("FOR UPDATE"))
          finalLocksAcquired = true;
      });
      const license = new LicenseClientService(db as any, env, () => {
        throw new Error("License HTTP forbidden in PG harness");
      });
      const sender = () =>
        new ConversionEventsService(
          client as any,
          new MetaCapiAdapter({}, fetcher),
          encryption,
          new MetaConnectionResolverService(client as any, encryption),
          {
            getLockState: async (tx?: Prisma.TransactionClient) => {
              // First read under locks enters inboundMetaDispatchAuthorized; the
              // second is AFTER its current route/context/owner reads.
              if (finalLocksAcquired && ++lockedLicenseReads === 2)
                await finalLicenseGate();
              return license.getLockState(tx);
            },
          } as any,
          env,
        );
      const send = () => sender().sendReadyEvent(log.id, { workspaceId: ws });
      const claim = () =>
        db.auditLog.findUnique({
          where: { id: `inbound-meta-dispatch:${log.id}` },
        });
      return {
        ws,
        owner,
        route,
        channel,
        credential,
        log,
        fetcher,
        send,
        claim,
      };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const mutations = [
      "owner update",
      "owner delete",
      "route pause",
      "route delete",
      "channel pause",
      "credential rotation",
      "license block",
    ] as const;
    type Mutation = (typeof mutations)[number];
    async function mutate(
      tx: Prisma.TransactionClient,
      h: Fixture,
      change: Mutation,
    ) {
      if (change === "owner update")
        await tx.workspaceMember.update({
          where: { id: h.owner.id },
          data: { role: "admin" },
        });
      if (change === "owner delete")
        await tx.workspaceMember.delete({ where: { id: h.owner.id } });
      if (change === "route pause")
        await tx.inboundWebhookChannelRoute.update({
          where: { id: h.route.id },
          data: { active: false },
        });
      if (change === "route delete")
        await tx.inboundWebhookChannelRoute.delete({
          where: { id: h.route.id },
        });
      if (change === "channel pause")
        await tx.inboundWebhookChannel.update({
          where: { id: h.channel.id },
          data: { status: "paused" },
        });
      if (change === "credential rotation")
        await tx.metaCredential.update({
          where: { id: h.credential.id },
          data: {
            ...encryption.encrypt("synthetic-rotated-token"),
            fingerprint: "synthetic-rotated",
          },
        });
      if (change === "license block")
        await tx.licenseState.update({
          where: { id: "singleton" },
          data: { status: "blocked" },
        });
    }

    it("actual committed AuditLog PK and log locks fence concurrent senders, restarts and reopening", async () => {
      const contenders = deferred(),
        http = deferred(),
        network = deferred<Response>();
      let claimEntries = 0;
      const h = await fixture(async (sql) => {
        // Both workers passed their initial no-claim read before either claims.
        if (sql.includes('FROM "Workspace"') && ++claimEntries <= 2) {
          if (claimEntries === 2) contenders.resolve();
          await waitFor(contenders.promise);
        }
      });
      h.fetcher.mockImplementationOnce(() => {
        http.resolve();
        return network.promise;
      });
      const race = raceTasks();
      const workers = [race.track(h.send()), race.track(h.send())];
      try {
        await waitFor(race.wait(http.promise));
        // Keep the log ready_to_send while the loser hits the REAL PK conflict.
        expect(await race.wait(Promise.race(workers))).toMatchObject({
          status: "skipped",
        });
        expect(await race.wait(h.claim())).toMatchObject({
          resultStatus: "dispatch_started",
        });
        expect(h.fetcher).toHaveBeenCalledTimes(1);
      } finally {
        contenders.resolve();
        network.resolve(ack());
        await race.settle();
      }
      expect((await Promise.all(workers)).map((r) => r.status).sort()).toEqual([
        "sent",
        "skipped",
      ]);
      expect(await h.claim()).toMatchObject({ resultStatus: "sent" });
      await db.conversionEventLog.update({
        where: { id: h.log.id },
        data: { status: "ready_to_send" },
      });
      expect(await h.send()).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    });

    it.each(mutations)(
      "%s committed AFTER prior reads, BEFORE dispatch lock denies all HTTP",
      async (change) => {
        const entered = deferred(),
          resume = deferred();
        let workspaceLocks = 0;
        const h = await fixture(async (sql) => {
          if (sql.includes('FROM "Workspace"') && ++workspaceLocks === 2) {
            entered.resolve();
            await waitFor(resume.promise);
          }
        });
        const race = raceTasks();
        const sending = race.track(h.send());
        try {
          await waitFor(race.wait(entered.promise));
          expect(await race.wait(h.claim())).toMatchObject({
            resultStatus: "dispatch_started",
          }); // separate transaction committed
          expect(h.fetcher).not.toHaveBeenCalled();
          await race.wait(
            race.track(mutator.$transaction((tx) => mutate(tx, h, change))),
          ); // ordinary canonical DML; no cooperative sender lock
        } finally {
          resume.resolve();
          await race.settle();
        }
        expect(await sending).toMatchObject({ status: "skipped" });
        expect(h.fetcher).not.toHaveBeenCalled();
        expect(await h.claim()).toMatchObject({
          resultStatus: "dispatch_started",
        });
        expect(await h.send()).toMatchObject({ status: "skipped" });
      },
    );

    it.each(mutations)(
      "%s ordered AFTER final locks waits until HTTP starts, then commits while network is pending",
      async (change) => {
        const entered = deferred(),
          resume = deferred(),
          pid = deferred<number>(),
          network = deferred<Response>(),
          http = deferred();
        // Pause the final license await AFTER all current credential/route/owner
        // reads. Ordinary DML must remain blocked through synchronous HTTP start.
        const h = await fixture(
          async () => undefined,
          async () => {
            entered.resolve();
            await waitFor(resume.promise);
          },
        );
        h.fetcher.mockImplementationOnce(() => {
          http.resolve();
          return network.promise;
        });
        const race = raceTasks();
        const sending = race.track(h.send());
        let mutation: Promise<unknown> | undefined;
        try {
          await waitFor(race.wait(entered.promise));
          expect(await race.wait(h.claim())).toMatchObject({
            resultStatus: "dispatch_started",
          });
          mutation = race.track(
            mutator.$transaction(async (tx) => {
              const [row] = await tx.$queryRaw<
                Array<{ pid: number }>
              >`SELECT pg_backend_pid() AS pid`;
              pid.resolve(row.pid);
              await mutate(tx, h, change);
            }),
          );
          const backend = await waitFor(race.wait(pid.promise));
          // Database-observed blocking, not elapsed-time assumptions or mocked locks.
          const deadline = Date.now() + 1000;
          let blocked = false;
          while (!blocked && Date.now() < deadline) {
            const [row] = await race.wait(
              observer.$queryRaw<
                Array<{ blocked: boolean }>
              >`SELECT cardinality(pg_blocking_pids(${backend}::integer)) > 0 AS blocked`,
            );
            blocked = row.blocked;
            if (!blocked) await new Promise((r) => setTimeout(r, 5));
          }
          expect(blocked).toBe(true);
          expect(h.fetcher).not.toHaveBeenCalled();
          resume.resolve();
          await waitFor(race.wait(http.promise));
          await race.wait(mutation); // provider response remains deferred; DB locks already released
          expect(await race.wait(h.send())).toMatchObject({
            status: "skipped",
          });
          expect(h.fetcher).toHaveBeenCalledTimes(1);
        } finally {
          resume.resolve();
          network.resolve(ack());
          await race.settle();
        }
        expect(await sending).toMatchObject({ status: "sent" });
        expect(h.fetcher).toHaveBeenCalledTimes(1);
      },
    );
  },
);
