import type {
  IntegrationDetectedProductDto,
  IntegrationEndpointListDto,
  IntegrationEndpointProviderDto,
  IntegrationUnattributedEventListDto,
} from "@wpptrack/shared";
import {
  integrationDetectedProductListSchema,
  integrationEndpointListSchema,
  integrationUnattributedEventListSchema,
} from "@wpptrack/shared";
import { serverApiFetch } from "../../../../lib/server-api";

/**
 * Leituras da Fase 5.3. Cada uma falha sozinha: uma API antiga (sem as rotas
 * novas) ou indisponível nunca derruba a tela de Integrações ou Conversões.
 * Nenhuma delas traz a URL com a chave (a listagem sempre vem com `url: null`).
 */
export type SingleUrlData = {
  endpoints: IntegrationEndpointListDto | null;
  paytProducts: IntegrationDetectedProductDto[];
  unattributed: Record<
    IntegrationEndpointProviderDto,
    IntegrationUnattributedEventListDto | null
  >;
};

async function settle<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export async function loadDetectedProducts(): Promise<
  IntegrationDetectedProductDto[]
> {
  const parsed = integrationDetectedProductListSchema.safeParse(
    await settle(
      serverApiFetch<unknown>("/integrations/endpoints/products?provider=payt"),
    ),
  );
  return parsed.success ? parsed.data.products : [];
}

async function loadUnattributed(
  provider: IntegrationEndpointProviderDto,
): Promise<IntegrationUnattributedEventListDto | null> {
  const parsed = integrationUnattributedEventListSchema.safeParse(
    await settle(
      serverApiFetch<unknown>(
        `/integrations/endpoints/unattributed?provider=${provider}`,
      ),
    ),
  );
  return parsed.success ? parsed.data : null;
}

export async function loadSingleUrlData(): Promise<SingleUrlData> {
  const [endpoints, paytProducts, payt, unnichat, umbler] = await Promise.all([
    settle(serverApiFetch<unknown>("/integrations/endpoints")),
    loadDetectedProducts(),
    loadUnattributed("payt"),
    loadUnattributed("unnichat"),
    loadUnattributed("umbler"),
  ]);
  const parsedEndpoints = integrationEndpointListSchema.safeParse(endpoints);
  return {
    endpoints: parsedEndpoints.success ? parsedEndpoints.data : null,
    paytProducts,
    unattributed: { payt, unnichat, umbler },
  };
}
