"use client";

import type {
  IntegrationDetectedProductDto,
  IntegrationEndpointDto,
  IntegrationEndpointProviderDto,
  IntegrationLegacyUrlDto,
  IntegrationUnattributedEventListDto,
} from "@wpptrack/shared";
import {
  Check,
  Copy,
  EyeOff,
  Link2,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SingleUrlActionResult } from "./single-url-actions";
import {
  disableLegacyUrlConfirmText,
  eventLabel,
  findEventEndpoint,
  formatCents,
  formatWhen,
  isSalesPlatform,
  legacyUrlState,
  mergeEndpoints,
  normalizeManualProductCode,
  paytEventExplanations,
  paytProductCodeGuidance,
  productCodeSeen,
  productFilterOptions,
  removeConfirmText,
  rotateConfirmText,
  singleUrlLicenseLockedNote,
  singleUrlPlatformNames,
  singleUrlReadOnlyNote,
  singleUrlRevealNote,
  singleUrlSetupSteps,
  statsSummary,
  supportedEvents,
  unseenProductCodeWarning,
} from "./single-url-copy";

type Action = (formData: FormData) => Promise<SingleUrlActionResult>;

export type SingleUrlActions = {
  ensure: Action;
  /** "Mostrar URL" (auditado): a listagem nunca traz a URL com a chave. */
  reveal: Action;
  rotate: Action;
  remove: Action;
  retry: Action;
  setPublicUrl: Action;
};

function useRefresh() {
  const router = useRouter();
  return () => {
    try {
      router.refresh();
    } catch {
      // Fora do app router (testes): nada para atualizar.
    }
  };
}

function LockedNote({ locked }: { locked: boolean }) {
  return locked ? (
    <p className="action-note warn" role="note">
      {singleUrlLicenseLockedNote}
    </p>
  ) : null;
}

function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      className="button"
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {state === "copied" ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      {state === "copied"
        ? "Copiada"
        : state === "failed"
          ? "Copie manualmente"
          : "Copiar URL"}
    </button>
  );
}

type Confirming = "rotate" | "remove" | null;

/**
 * Um endereço do workspace: contadores, último recebimento e as ações. A URL
 * com a chave fica só na memória deste componente (nunca em localStorage, na
 * barra de endereço ou em log) e some com "Ocultar URL" ou ao sair da tela.
 */
export function IntegrationUrlBox({
  endpoint,
  label,
  canManage,
  licenseLocked = false,
  actions,
  onRemoved,
}: {
  endpoint: IntegrationEndpointDto;
  label: string;
  canManage: boolean;
  licenseLocked?: boolean;
  actions: Pick<SingleUrlActions, "reveal" | "rotate" | "remove">;
  onRemoved?: (endpointId: string) => void;
}) {
  const refresh = useRefresh();
  // undefined = segue o que o servidor mandou; null = ocultada de propósito.
  const [shown, setShown] = useState<string | null | undefined>(undefined);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const url = shown === undefined ? endpoint.url : shown;
  const writable = canManage && !licenseLocked;

  async function run(
    action: Action,
    fallback: string,
    onOk: (result: SingleUrlActionResult) => void,
  ) {
    setPending(true);
    const formData = new FormData();
    formData.set("endpointId", endpoint.id);
    const result = await action(formData).catch(() => null);
    setPending(false);
    setConfirming(null);
    if (result?.ok) {
      onOk(result);
      return;
    }
    setMessage(result?.message ?? fallback);
  }

  return (
    <div className="single-url-box">
      {url ? (
        <div className="conversion-webhook-url">
          <label className="conversion-field">
            <span className="field-label">{label}</span>
            <input
              readOnly
              value={url}
              data-presentation-sensitive-field="true"
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <CopyButton value={url} />
          <button
            className="button ghost"
            type="button"
            onClick={() => setShown(null)}
          >
            <EyeOff size={14} aria-hidden="true" />
            Ocultar URL
          </button>
        </div>
      ) : canManage ? (
        <div className="conversion-field">
          <span className="field-label">{label}</span>
          <button
            className="button"
            type="button"
            disabled={pending || licenseLocked}
            onClick={() =>
              void run(
                actions.reveal,
                "Não deu para mostrar a URL agora.",
                (result) => {
                  setShown(result.endpoint?.url ?? null);
                  setMessage(null);
                },
              )
            }
          >
            <Link2 size={14} aria-hidden="true" />
            Mostrar URL
          </button>
          <small className="muted">{singleUrlRevealNote}</small>
        </div>
      ) : (
        <p className="action-note">{singleUrlReadOnlyNote}</p>
      )}

      <dl className="conversion-flow-summary">
        <div>
          <dt>Último recebimento</dt>
          <dd>{formatWhen(endpoint.lastDeliveryAt)}</dd>
        </div>
        <div>
          <dt>Última entrega a uma regra</dt>
          <dd>{formatWhen(endpoint.lastRoutedAt)}</dd>
        </div>
        <div>
          <dt>Contadores</dt>
          <dd>{statsSummary(endpoint.stats)}</dd>
        </div>
        <div>
          <dt>Chave trocada em</dt>
          <dd>
            {endpoint.rotatedAt
              ? formatWhen(endpoint.rotatedAt)
              : "nunca foi trocada"}
          </dd>
        </div>
      </dl>

      {message ? (
        <p className="action-note" role="status">
          {message}
        </p>
      ) : null}

      {canManage ? (
        <>
          <LockedNote locked={licenseLocked} />
          {confirming === "rotate" ? (
            <div className="conversion-inline-confirm" role="alert">
              <p>{rotateConfirmText(endpoint.provider)}</p>
              <div className="conversion-flow-actions">
                <button
                  className="button"
                  type="button"
                  onClick={() => setConfirming(null)}
                  disabled={pending}
                >
                  Cancelar
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={pending || !writable}
                  onClick={() =>
                    void run(
                      actions.rotate,
                      "Não deu para gerar uma nova URL agora.",
                      (result) => {
                        setShown(result.endpoint?.url ?? null);
                        setMessage(result.message);
                        refresh();
                      },
                    )
                  }
                >
                  {pending ? "Gerando..." : "Gerar nova URL"}
                </button>
              </div>
            </div>
          ) : confirming === "remove" ? (
            <div className="conversion-inline-confirm" role="alert">
              <p>{removeConfirmText(endpoint.provider)}</p>
              <div className="conversion-flow-actions">
                <button
                  className="button"
                  type="button"
                  onClick={() => setConfirming(null)}
                  disabled={pending}
                >
                  Cancelar
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={pending || !writable}
                  onClick={() =>
                    void run(
                      actions.remove,
                      "Não deu para remover a URL agora.",
                      () => {
                        setShown(null);
                        onRemoved?.(endpoint.id);
                        refresh();
                      },
                    )
                  }
                >
                  {pending ? "Removendo..." : "Remover URL"}
                </button>
              </div>
            </div>
          ) : (
            <div className="conversion-flow-actions">
              <button
                className="button ghost"
                type="button"
                disabled={!writable}
                onClick={() => setConfirming("rotate")}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Gerar nova URL
              </button>
              <button
                className="button ghost"
                type="button"
                disabled={!writable}
                onClick={() => setConfirming("remove")}
              >
                <Trash2 size={14} aria-hidden="true" />
                Remover URL
              </button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Cria (ou reaproveita) a URL da plataforma/evento e a entrega ao pai. */
export function EnsureUrlButton({
  provider,
  eventName,
  ensure,
  label,
  onReady,
  variant = "primary",
  confirmText = null,
  disabled = false,
}: {
  provider: IntegrationEndpointProviderDto;
  eventName: string | null;
  ensure: Action;
  label: string;
  onReady: (endpoint: IntegrationEndpointDto) => void;
  /** "secondary" para URLs opcionais (ex.: “URL de outro evento”). */
  variant?: "primary" | "secondary";
  /** Quando definido, o usuário confirma antes de a URL ser criada. */
  confirmText?: string | null;
  disabled?: boolean;
}) {
  const refresh = useRefresh();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("provider", provider);
    if (eventName) formData.set("eventName", eventName);
    const result = await ensure(formData).catch(() => null);
    setPending(false);
    if (result?.ok && result.endpoint) {
      onReady(result.endpoint);
      refresh();
      return;
    }
    setError(result?.message ?? "Não deu para gerar a URL agora.");
  }

  if (confirming && confirmText) {
    return (
      <div className="conversion-inline-confirm" role="alert">
        <p>{confirmText}</p>
        <div className="conversion-flow-actions">
          <button
            className="button"
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
          >
            Cancelar
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => {
              setConfirming(false);
              void create();
            }}
            disabled={pending}
          >
            Gerar URL
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        className={variant === "primary" ? "button primary" : "button"}
        type="button"
        onClick={() => (confirmText ? setConfirming(true) : void create())}
        disabled={pending || disabled}
      >
        <Link2 size={15} aria-hidden="true" />
        {pending ? "Gerando..." : label}
      </button>
      {error ? (
        <p className="action-note warn" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function SetupSteps({
  provider,
  eventName,
}: {
  provider: IntegrationEndpointProviderDto;
  eventName: string | null;
}) {
  return (
    <ol className="integration-steps">
      {singleUrlSetupSteps(provider, eventName).map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

const unattributedTitles: Record<IntegrationEndpointProviderDto, string> = {
  payt: "Vendas sem atribuição",
  unnichat: "Eventos sem atribuição",
  umbler: "Eventos sem atribuição",
};

export function unattributedTitle(
  provider: IntegrationEndpointProviderDto,
): string {
  return unattributedTitles[provider];
}

export function UnattributedSalesList({
  list,
  canManage,
  licenseLocked = false,
  retry,
  limit = 20,
}: {
  list: IntegrationUnattributedEventListDto | null;
  canManage: boolean;
  licenseLocked?: boolean;
  retry: Action;
  limit?: number;
}) {
  const refresh = useRefresh();
  const [results, setResults] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (!list) {
    return (
      <p className="action-note">
        Não deu para ler esta lista agora. Atualize a página em instantes.
      </p>
    );
  }
  if (list.items.length === 0) {
    return (
      <p className="muted">
        Nada sem atribuição. Tudo o que chegou encontrou uma regra.
      </p>
    );
  }

  async function retryOne(eventId: string) {
    setPendingId(eventId);
    const formData = new FormData();
    formData.set("eventId", eventId);
    const result = await retry(formData).catch(() => null);
    setPendingId(null);
    setResults((current) => ({
      ...current,
      [eventId]: result?.message ?? "Não deu para tentar de novo agora.",
    }));
    if (result?.ok) refresh();
  }

  const shown = list.items.slice(0, limit);

  return (
    <div className="single-url-unattributed">
      <p className="muted">
        {list.total}{" "}
        {list.total === 1
          ? "recebido que não virou conversão"
          : "recebidos que não viraram conversão"}
        {list.total > shown.length ? ` (mostrando os ${shown.length} mais recentes)` : ""}
        . Crie ou ajuste a regra e use “Tentar de novo”.
      </p>
      <ul className="single-url-list" role="list">
        {shown.map((item) => (
          <li key={item.id} className="single-url-list-item">
            <div>
              <strong>{eventLabel(item.eventName, item.provider)}</strong>
              <span className="muted">
                {" · "}
                {formatWhen(item.lastReceivedAt)}
                {item.valueCents !== null
                  ? ` · ${formatCents(item.valueCents, item.currency)}`
                  : ""}
                {item.productName || item.productCode
                  ? ` · ${item.productName ?? ""}${item.productCode ? ` (${item.productCode})` : ""}`
                  : ""}
                {item.attemptCount > 1
                  ? ` · ${item.attemptCount} tentativas`
                  : ""}
              </span>
            </div>
            <span className="status-chip warn">{item.reasonLabel}</span>
            {canManage && item.retryable ? (
              <button
                className="button ghost"
                type="button"
                onClick={() => void retryOne(item.id)}
                disabled={pendingId === item.id || licenseLocked}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {pendingId === item.id ? "Tentando..." : "Tentar de novo"}
              </button>
            ) : null}
            {!item.retryable ? (
              <small className="muted">
                O corpo já foi apagado (guardamos por 7 dias) ou a URL foi
                removida: não dá para tentar de novo.
              </small>
            ) : null}
            {results[item.id] ? (
              <small className="action-note" role="status">
                {results[item.id]}
              </small>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? <LockedNote locked={licenseLocked} /> : null}
    </div>
  );
}

export function DetectedProducts({
  products,
}: {
  products: readonly IntegrationDetectedProductDto[];
}) {
  if (products.length === 0) {
    return (
      <p className="muted">
        Os produtos aparecem aqui assim que a primeira venda chegar pela URL
        única.
      </p>
    );
  }
  return (
    <div className="single-url-table-wrap">
      <table className="single-url-table">
        <thead>
          <tr>
            <th>Produto</th>
            <th>Código</th>
            <th>Oferta (link)</th>
            <th>Última venda</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr key={`${product.productCode ?? ""}|${product.offerCode ?? ""}`}>
              <td data-label="Produto">
                <span>{product.productName ?? "—"}</span>
              </td>
              <td data-label="Código">
                <span className="single-url-code">
                  {product.productCode ?? "—"}
                </span>
              </td>
              <td data-label="Oferta (link)">
                <span>
                  {product.offerName ?? ""}{" "}
                  {product.offerCode ? (
                    <span className="single-url-code">{product.offerCode}</span>
                  ) : (
                    "—"
                  )}
                </span>
              </td>
              <td data-label="Última venda">
                <span>{formatWhen(product.lastSeenAt)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "URLs antigas": as regras que ainda têm a URL própria, com o último
 * recebimento por ela. Desativar pede confirmação e dá para reativar.
 */
export function LegacyUrlList({
  provider,
  legacyUrls,
  canManage,
  licenseLocked = false,
  setPublicUrl,
  numberNames = {},
}: {
  provider: IntegrationEndpointProviderDto;
  legacyUrls: readonly IntegrationLegacyUrlDto[];
  canManage: boolean;
  licenseLocked?: boolean;
  setPublicUrl: Action;
  numberNames?: Record<string, string>;
}) {
  const refresh = useRefresh();
  const [state, setState] = useState<Record<string, string | null>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const sales = isSalesPlatform(provider);
  const platform = singleUrlPlatformNames[provider];

  if (legacyUrls.length === 0) {
    return (
      <p className="muted">
        Nenhuma regra tem URL própria (por regra ou por número).
      </p>
    );
  }

  async function toggle(legacy: IntegrationLegacyUrlDto, disabled: boolean) {
    setConfirmingId(null);
    setPendingId(legacy.providerRuleId);
    const formData = new FormData();
    formData.set("ruleId", legacy.providerRuleId);
    formData.set("disabled", String(disabled));
    const result = await setPublicUrl(formData).catch(() => null);
    setPendingId(null);
    setMessage(result?.message ?? "Não deu para alterar agora.");
    if (result?.ok) {
      setState((current) => ({
        ...current,
        [legacy.providerRuleId]: disabled
          ? (result.publicUrlDisabledAt ?? new Date().toISOString())
          : null,
      }));
      refresh();
    }
  }

  return (
    <div className="single-url-migration">
      <p className="muted">
        {sales
          ? `As URLs antigas continuam funcionando enquanto você não desativar. Uma mesma venda que chegue pelas duas é enviada à Meta uma vez só. Depois de colar a URL única na ${platform} e ver as vendas chegando por ela, apague a antiga na ${platform} e desative aqui.`
          : `As URLs antigas continuam funcionando enquanto você não desativar. Um mesmo evento que chegue pelas duas é enviado à Meta uma vez só. Depois de colar a URL do evento ${provider === "unnichat" ? "no" : "na"} ${platform} e ver os eventos chegando por ela, apague a antiga lá e desative aqui.`}
      </p>
      <ul className="single-url-list" role="list">
        {legacyUrls.map((legacy) => {
          const disabledAt =
            legacy.providerRuleId in state
              ? state[legacy.providerRuleId]
              : legacy.publicUrlDisabledAt;
          const disabled = Boolean(disabledAt);
          const status = legacyUrlState({
            publicUrlDisabledAt: disabledAt,
            lastDeliveryAt: legacy.lastDeliveryAt,
          });
          const numbers =
            legacy.scope === "all_numbers"
              ? "Todos os números"
              : legacy.channelIds
                  .map((id) => numberNames[id] ?? "número removido")
                  .join(", ");
          return (
            <li key={legacy.providerRuleId} className="single-url-list-item">
              <div>
                <strong>{legacy.ruleName}</strong>
                <span className="muted">
                  {" · "}
                  {eventLabel(legacy.eventName, provider)} · {numbers}
                  {" · último recebimento pela URL antiga: "}
                  {formatWhen(legacy.lastDeliveryAt)}
                </span>
              </div>
              <span
                className={`status-chip${status.tone === "warn" ? " warn" : status.tone === "neutral" ? " neutral" : ""}`}
              >
                {status.label}
              </span>
              {canManage && confirmingId !== legacy.providerRuleId ? (
                <button
                  className="button ghost"
                  type="button"
                  disabled={
                    pendingId === legacy.providerRuleId || licenseLocked
                  }
                  onClick={() =>
                    disabled
                      ? void toggle(legacy, false)
                      : setConfirmingId(legacy.providerRuleId)
                  }
                >
                  {disabled ? "Reativar URL antiga" : "Desativar URL antiga"}
                </button>
              ) : null}
              {canManage && confirmingId === legacy.providerRuleId ? (
                <div className="conversion-inline-confirm" role="alert">
                  <p>{disableLegacyUrlConfirmText(provider)}</p>
                  <div className="conversion-flow-actions">
                    <button
                      className="button"
                      type="button"
                      onClick={() => setConfirmingId(null)}
                    >
                      Cancelar
                    </button>
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => void toggle(legacy, true)}
                    >
                      Desativar URL antiga
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canManage ? <LockedNote locked={licenseLocked} /> : null}
      {message ? (
        <p className="action-note" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

type PlatformPanelCommon = {
  unattributed: IntegrationUnattributedEventListDto | null;
  legacyUrls: readonly IntegrationLegacyUrlDto[];
  /** Eventos com regra ativa da plataforma. */
  ruleEvents: readonly string[];
  canManage: boolean;
  licenseLocked?: boolean;
  actions: SingleUrlActions;
  numberNames?: Record<string, string>;
};

/** Conteúdo do modal da Payt: URL única, eventos, produtos, vendas e URLs antigas. */
export function PaytSingleUrlPanel({
  endpoint,
  products,
  unattributed,
  legacyUrls,
  ruleEvents,
  canManage,
  licenseLocked = false,
  actions,
  numberNames,
}: PlatformPanelCommon & {
  endpoint: IntegrationEndpointDto | null;
  products: readonly IntegrationDetectedProductDto[];
}) {
  const [created, setCreated] = useState<IntegrationEndpointDto | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const current = mergeEndpoints(
    endpoint ? [endpoint] : [],
    created ? [created] : [],
    removed,
  )[0] ?? null;

  return (
    <div className="integration-modal-stack single-url-panel">
      <section
        className="integration-modal-note"
        aria-labelledby="payt-url-title"
      >
        <strong id="payt-url-title">URL única da Payt</strong>
        <p className="muted">
          Uma URL só para a conta toda: a Payt avisa cada venda e o sistema
          descobre por qual número o comprador chegou. Não precisa de uma URL
          por número nem por regra.
        </p>
        {current ? (
          <IntegrationUrlBox
            key={current.id}
            endpoint={current}
            label="URL única (cole na Payt, em Postback)"
            canManage={canManage}
            licenseLocked={licenseLocked}
            actions={actions}
            onRemoved={(id) => setRemoved((list) => [...list, id])}
          />
        ) : canManage ? (
          <>
            <EnsureUrlButton
              provider="payt"
              eventName={null}
              ensure={actions.ensure}
              label="Gerar URL única"
              onReady={setCreated}
              disabled={licenseLocked}
            />
            <LockedNote locked={licenseLocked} />
          </>
        ) : (
          <p className="action-note">
            Ainda não há URL única. Peça a quem gerencia integrações para
            gerar.
          </p>
        )}
        <SetupSteps provider="payt" eventName={null} />
      </section>

      <section
        className="integration-modal-note"
        aria-labelledby="payt-events-title"
      >
        <strong id="payt-events-title">Eventos suportados</strong>
        <ul className="single-url-list" role="list">
          {supportedEvents("payt").map((eventName) => {
            const hasRule = ruleEvents.includes(eventName);
            return (
              <li key={eventName} className="single-url-list-item">
                <div>
                  <strong>{eventLabel(eventName, "payt")}</strong>
                  <span className="muted">
                    {" · "}
                    {paytEventExplanations[eventName] ?? ""}
                  </span>
                </div>
                <span className={`status-chip${hasRule ? "" : " neutral"}`}>
                  {hasRule ? "Com regra ativa" : "Sem regra (não é enviado)"}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="muted">
          Cada evento só vai para a Meta se existir uma regra ativa dele em
          Conversões.
        </p>
      </section>

      <section
        className="integration-modal-note"
        aria-labelledby="payt-products-title"
      >
        <strong id="payt-products-title">Produtos detectados</strong>
        <DetectedProducts products={products} />
      </section>

      <section
        className="integration-modal-note"
        aria-labelledby="payt-unattributed-title"
      >
        <strong id="payt-unattributed-title">
          {unattributedTitle("payt")}
        </strong>
        <UnattributedSalesList
          list={unattributed}
          canManage={canManage}
          licenseLocked={licenseLocked}
          retry={actions.retry}
          limit={10}
        />
      </section>

      <section
        className="integration-modal-note"
        aria-labelledby="payt-legacy-title"
      >
        <strong id="payt-legacy-title">URLs antigas</strong>
        <LegacyUrlList
          provider="payt"
          legacyUrls={legacyUrls}
          canManage={canManage}
          licenseLocked={licenseLocked}
          setPublicUrl={actions.setPublicUrl}
          numberNames={numberNames}
        />
      </section>
    </div>
  );
}

/** "URLs por evento" do modal do Unnichat e da Umbler Talk. */
export function AutomationEventUrlsPanel({
  provider,
  endpoints,
  unattributed,
  legacyUrls,
  ruleEvents,
  canManage,
  licenseLocked = false,
  actions,
  numberNames,
}: PlatformPanelCommon & {
  provider: Exclude<IntegrationEndpointProviderDto, "payt">;
  endpoints: readonly IntegrationEndpointDto[];
}) {
  const [created, setCreated] = useState<IntegrationEndpointDto[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const all = mergeEndpoints(endpoints, created, removed);
  const platform = singleUrlPlatformNames[provider];
  const events = supportedEvents(provider).filter(
    (eventName) =>
      ruleEvents.includes(eventName) ||
      Boolean(findEventEndpoint(all, provider, eventName)),
  );
  const offered = supportedEvents(provider).filter(
    (eventName) => !events.includes(eventName),
  );

  return (
    <div className="integration-modal-stack single-url-panel">
      <section
        className="integration-modal-note"
        aria-labelledby={`${provider}-event-urls-title`}
      >
        <strong id={`${provider}-event-urls-title`}>URLs por evento</strong>
        <p className="muted">
          Uma URL por evento (ex.: Lead qualificado, Compra), válida para todos
          os números da conta. O sistema descobre o número pela conversa de
          origem; a regra específica de um número vence a regra de todos os
          números.
        </p>
        {events.length === 0 ? (
          <p className="muted">
            Crie uma regra {provider === "unnichat" ? "do" : "da"} {platform} em
            Conversões ou gere a URL de um evento abaixo.
          </p>
        ) : (
          <ul className="single-url-list" role="list">
            {events.map((eventName) => {
              const endpoint = findEventEndpoint(all, provider, eventName);
              return (
                <li key={eventName} className="single-url-event">
                  <strong>{eventLabel(eventName)}</strong>
                  {endpoint ? (
                    <IntegrationUrlBox
                      key={endpoint.id}
                      endpoint={endpoint}
                      label={`URL de “${eventLabel(eventName)}”`}
                      canManage={canManage}
                      licenseLocked={licenseLocked}
                      actions={actions}
                      onRemoved={(id) => setRemoved((list) => [...list, id])}
                    />
                  ) : canManage ? (
                    <EnsureUrlButton
                      provider={provider}
                      eventName={eventName}
                      ensure={actions.ensure}
                      label={`Gerar URL de “${eventLabel(eventName)}”`}
                      disabled={licenseLocked}
                      onReady={(next) => setCreated((list) => [...list, next])}
                    />
                  ) : (
                    <p className="action-note">
                      Ainda não há URL para este evento. Peça a quem gerencia
                      integrações para gerar.
                    </p>
                  )}
                  {!ruleEvents.includes(eventName) ? (
                    <small className="action-note warn">
                      Sem regra ativa deste evento: o que chegar fica sem
                      atribuição.
                    </small>
                  ) : null}
                  <SetupSteps provider={provider} eventName={eventName} />
                </li>
              );
            })}
          </ul>
        )}
        {canManage && offered.length > 0 ? (
          <details className="single-url-more">
            <summary>Gerar URL de outro evento</summary>
            <div className="single-url-offered">
              {offered.map((eventName) => (
                <EnsureUrlButton
                  key={eventName}
                  provider={provider}
                  eventName={eventName}
                  ensure={actions.ensure}
                  label={eventLabel(eventName)}
                  variant="secondary"
                  disabled={licenseLocked}
                  confirmText={`Gerar a URL de “${eventLabel(eventName)}”? Ela só envia algo à Meta quando existir uma regra ativa deste evento em Conversões; sem regra, o que chegar fica sem atribuição.`}
                  onReady={(next) => setCreated((list) => [...list, next])}
                />
              ))}
            </div>
          </details>
        ) : null}
        {canManage ? <LockedNote locked={licenseLocked} /> : null}
      </section>

      <section
        className="integration-modal-note"
        aria-labelledby={`${provider}-unattributed-title`}
      >
        <strong id={`${provider}-unattributed-title`}>
          {unattributedTitle(provider)}
        </strong>
        <UnattributedSalesList
          list={unattributed}
          canManage={canManage}
          licenseLocked={licenseLocked}
          retry={actions.retry}
          limit={10}
        />
      </section>

      <section
        className="integration-modal-note"
        aria-labelledby={`${provider}-legacy-title`}
      >
        <strong id={`${provider}-legacy-title`}>URLs antigas</strong>
        <LegacyUrlList
          provider={provider}
          legacyUrls={legacyUrls}
          canManage={canManage}
          licenseLocked={licenseLocked}
          setPublicUrl={actions.setPublicUrl}
          numberNames={numberNames}
        />
      </section>
    </div>
  );
}

/**
 * Filtro opcional de produto da regra da Payt: marque os detectados ou
 * digite um código. Sem nada marcado, a regra vale para todos os produtos.
 */
export function ProductFilterPicker({
  products,
  selected,
  onChange,
  disabled = false,
}: {
  products: readonly IntegrationDetectedProductDto[];
  selected: readonly string[];
  onChange: (codes: string[]) => void;
  disabled?: boolean;
}) {
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const options = productFilterOptions(products);
  const manualCodes = selected.filter(
    (code) => !options.some((option) => option.code === code),
  );

  function toggle(code: string) {
    onChange(
      selected.includes(code)
        ? selected.filter((item) => item !== code)
        : [...selected, code],
    );
  }

  function addManual() {
    const code = normalizeManualProductCode(manual);
    if (!code) {
      setManualError("Digite só o código (letras, números, - _ ou .).");
      return;
    }
    setManualError(null);
    setManual("");
    if (!selected.includes(code)) onChange([...selected, code]);
  }

  return (
    <fieldset
      className="conversion-field single-url-products"
      disabled={disabled}
    >
      <legend className="field-label">Produtos (opcional)</legend>
      <small className="muted">
        Sem marcar nada, a regra vale para todos os produtos. Marcando, só
        vendas destes produtos ou ofertas usam esta regra; as outras seguem
        para a regra geral, se houver.
      </small>
      {options.length > 0 ? (
        <ul className="single-url-list" role="list">
          {options.map((option) => (
            <li key={option.code}>
              <label className="conversion-check">
                <input
                  type="checkbox"
                  checked={selected.includes(option.code)}
                  onChange={() => toggle(option.code)}
                />
                <span>
                  {option.label}{" "}
                  <span className="single-url-code">{option.code}</span>{" "}
                  <small className="muted">{option.kind}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          Nenhum produto visto ainda. Os produtos aparecem depois da primeira
          venda pela URL única; se precisar, digite o código abaixo.
        </p>
      )}
      <div className="conversion-field-row">
        <label className="conversion-field">
          <span className="field-label">Código digitado</span>
          <input
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addManual();
              }
            }}
            placeholder="Ex.: 4O9J39"
            maxLength={80}
          />
        </label>
        <button className="button" type="button" onClick={addManual}>
          Adicionar código
        </button>
      </div>
      <small className="action-note">{paytProductCodeGuidance}</small>
      {manualError ? (
        <small className="action-note warn" role="alert">
          {manualError}
        </small>
      ) : null}
      {manualCodes.map((code) => (
        <div key={code} className="single-url-manual-code">
          <span className="single-url-code">{code}</span>
          {!productCodeSeen(code, products) ? (
            <small className="action-note warn">
              {unseenProductCodeWarning}
            </small>
          ) : null}
          <button
            className="button ghost"
            type="button"
            onClick={() => toggle(code)}
          >
            Remover
          </button>
        </div>
      ))}
    </fieldset>
  );
}
