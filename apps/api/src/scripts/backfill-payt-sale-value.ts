import { PrismaClient } from "@prisma/client";
import { loadLocalEnv } from "../config/load-env";
import {
  PAYT_VALUE_BACKFILL_DEFAULT_LIMIT,
  PAYT_VALUE_BACKFILL_MAX_LIMIT,
  runPaytValueBackfill,
} from "../inbound-webhook-production/payt-value-backfill";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";

/**
 * Payt: corrige o valor das vendas já registradas com os juros do
 * parcelamento (total_price) para o valor sem juros
 * (price_without_installments). Só corrige o que ainda NÃO foi enviado à
 * Meta; o que já foi enviado não muda. Dry-run por padrão; nada é reenviado.
 *
 *   pnpm --filter @wpptrack/api payt:value-backfill -- [--workspace <id>]
 *     [--limit 200] [--after <conversionEventLogId>]
 *     [--apply --actor-email owner@dominio.com]
 *
 * Passo a passo em docs/setup/payt.md (seção "Corrigir o valor das vendas
 * já registradas").
 */

type Args = {
  apply: boolean;
  limit: number;
  workspaceId?: string;
  afterId?: string;
  actorEmail?: string;
};

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, limit: PAYT_VALUE_BACKFILL_DEFAULT_LIMIT };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--apply") {
      args.apply = true;
      continue;
    }
    if (value === undefined) continue;
    if (key === "--limit") {
      const limit = Number(value);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > PAYT_VALUE_BACKFILL_MAX_LIMIT
      )
        throw new Error(
          `--limit deve ser um inteiro entre 1 e ${PAYT_VALUE_BACKFILL_MAX_LIMIT}.`,
        );
      args.limit = limit;
    } else if (key === "--workspace") args.workspaceId = value.trim();
    else if (key === "--after") args.afterId = value.trim();
    else if (key === "--actor-email") args.actorEmail = value.trim();
    else continue;
    index += 1;
  }
  return args;
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    let actorUserId: string | undefined;
    if (args.apply) {
      if (!args.actorEmail)
        throw new Error("--apply exige --actor-email de um Platform Owner.");
      const actor = await prisma.user.findFirst({
        where: {
          email: { equals: args.actorEmail, mode: "insensitive" },
          platformRole: "platform_owner",
        },
        select: { id: true },
      });
      if (!actor)
        throw new Error(
          "O e-mail informado não pertence a um Platform Owner ativo.",
        );
      actorUserId = actor.id;
    }
    const report = await runPaytValueBackfill(
      prisma,
      new InboundWebhookPayloadEncryptionService(process.env),
      {
        apply: args.apply,
        limit: args.limit,
        workspaceId: args.workspaceId,
        afterId: args.afterId,
        actorUserId,
      },
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
