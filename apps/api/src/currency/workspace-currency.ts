import {
  DEFAULT_CURRENCY_CODE,
  normalizeCurrencyCode,
  type CurrencyCode,
} from "@wpptrack/shared";

type WorkspaceCurrencyReader = {
  workspace?: {
    findUnique?: (args: {
      where: { id: string };
      select: { conversionCurrency: true };
    }) => Promise<{ conversionCurrency?: string | null } | null>;
  };
};

/**
 * "Moeda das conversões" do workspace. Defensivo: sem workspace, sem coluna
 * (cliente antigo ou mocks de teste) ou com erro de leitura, volta BRL (o
 * comportamento histórico) e nunca quebra o registro de uma conversão.
 */
export async function loadWorkspaceConversionCurrency(
  prisma: unknown,
  workspaceId: string | null | undefined,
): Promise<CurrencyCode> {
  if (!workspaceId) return DEFAULT_CURRENCY_CODE;

  try {
    // Inside the try: a test double may even throw on the property access.
    const reader = prisma as WorkspaceCurrencyReader | null | undefined;
    const findUnique = reader?.workspace?.findUnique;
    if (typeof findUnique !== "function") {
      return DEFAULT_CURRENCY_CODE;
    }

    const workspace = await findUnique.call(reader!.workspace, {
      where: { id: workspaceId },
      select: { conversionCurrency: true },
    });
    return (
      normalizeCurrencyCode(workspace?.conversionCurrency) ??
      DEFAULT_CURRENCY_CODE
    );
  } catch {
    return DEFAULT_CURRENCY_CODE;
  }
}
