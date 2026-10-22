// Delete a workspace and all its FK-referencing rows, in FK-safe order.
// Usage: node scripts/delete-workspace.js <workspaceId>
// Run from apps/api so that @prisma/client resolves. Requires DATABASE_URL.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const WS = process.argv[2];

const order = [
  "purchaseValueAdjustment",
  "purchaseReviewItem",
  "purchaseReview",
  "providerPurchaseClaim",
  "providerRuleCreateClaim",
  "providerConversionRuleExecution",
  "providerConversionDecisionAudit",
  "providerConversionShadowComparison",
  "providerConversionRuleChannel",
  "providerConversionRuleEndpoint",
  "conversionCatalogVariant",
  "conversionCatalogAttribute",
  "conversionCatalog",
  "providerConversionRuleConfig",
  "inboundWebhookReplayItem",
  "inboundWebhookReplayBatch",
  "inboundWebhookProductionItem",
  "inboundWebhookEvent",
  "inboundWebhookDelivery",
  "integrationEndpointEvent",
  "integrationEndpoint",
  "inboundWebhookChannelRoute",
  "inboundWebhookChannel",
  "inboundWebhookConnection",
  "externalIngestionRecord",
  "externalSyncCursor",
  "externalCapiCutover",
  "externalDataConnector",
  "kommoConversionDedupe",
  "kommoWebhookEvent",
  "kommoConversionRule",
  "kommoPipelineCatalog",
  "kommoConnection",
  "pipedriveConversionDedupe",
  "pipedriveWebhookEvent",
  "pipedriveConversionRule",
  "pipedriveStageCatalog",
  "pipedrivePipelineCatalog",
  "pipedriveConnection",
  "metaAdDestinationAssignment",
  "metaAdDailyInsight",
  "metaAd",
  "metaAdSetDailyInsight",
  "metaAdSet",
  "metaCampaignDailyInsight",
  "metaCampaign",
  "metaReportingAccountDestination",
  "metaReportingAccount",
  "metaConversionDestination",
  "metaAssetSnapshot",
  "metaBusinessConnection",
  "metaCredential",
  "metaIntegration",
  "whatsappSeat",
  "whatsappInstanceActivation",
  "uazapiChatLabelState",
  "whatsappInstance",
  "conversionEventLog",
  "conversionRule",
  "funnelStageConfiguration",
  "lead",
  "webhookLog",
  "integrationLog",
  "jobAttempt",
  "diagnosticEvent",
  "billingInvoice",
  "billingContractAudit",
  "billingProviderEvent",
  "paymentCharge",
  "workspaceSubscription",
  "workspaceBillingProfile",
  "workspaceInvite",
  "workspaceMember",
  "metaOAuthState",
];

async function main() {
  if (!WS) {
    console.error("Uso: node scripts/delete-workspace.js <workspaceId>");
    process.exit(1);
  }

  const w = await prisma.workspace.findUnique({ where: { id: WS } });
  if (!w) {
    console.log("workspace ja nao existe:", WS);
    return;
  }
  console.log("excluindo:", w.name, "|", w.slug, "|", w.id);

  for (const model of order) {
    try {
      const r = await prisma[model].deleteMany({ where: { workspaceId: WS } });
      if (r.count > 0) console.log(model + ": " + r.count);
    } catch (e) {
      console.log("skip " + model + ": " + (e.message || "").slice(0, 120));
    }
  }

  try {
    await prisma.workspace.delete({ where: { id: WS } });
    console.log("OK - workspace excluido:", WS);
  } catch (e) {
    console.error("ERRO ao excluir workspace:", e.message);
    console.error(
      "Alguma tabela ainda referencia este workspace. Me mande esta mensagem inteira.",
    );
    process.exit(1);
  }

  const restantes = await prisma.workspace.findMany({
    select: { id: true, slug: true },
    orderBy: { createdAt: "asc" },
  });
  console.log("total workspaces agora:", restantes.length);
  restantes.forEach((x) => console.log("-", x.slug, "|", x.id));
}

main()
  .catch((e) => {
    console.error("ERRO:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
