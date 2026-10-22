"use client";

import type {
  IntegrationEndpointDto,
  IntegrationEndpointProviderDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ProviderConversionRuleActionResult } from "./actions";
import { originBetaEvents } from "./conversion-origins";
import { PaytSetupPanel } from "./payt-setup";
import { UmblerAutomationPayloadPanel } from "./umbler-automation-payload";
import {
  UnnichatAutomationSetupPanel,
  UnnichatWebhookBody,
} from "../integrations/unnichat-setup";
import {
  disableLegacyUrlConfirmText,
  singleUrlLicenseLockedNote,
  singleUrlSetupSteps,
} from "../integrations/single-url/single-url-copy";
import {
  EnsureUrlButton,
  IntegrationUrlBox,
  type SingleUrlActions,
} from "../integrations/single-url/single-url-panels";
import { ruleEventLabelForOrigin, ruleEventLabel } from "./event-copy";

type RuleAction = (formData: FormData) => Promise<ProviderConversionRuleActionResult>;

const platformNames: Partial<Record<ProviderConversionRuleOriginDto, string>> = {
  automation_umbler: "Umbler Talk",
  automation_unnichat: "Unnichat",
  automation_payt: "Payt",
};

// Artigo por plataforma: "na Umbler Talk", "na Payt", mas "no Unnichat".
const platformLocatives: Partial<Record<ProviderConversionRuleOriginDto, string>> = {
  automation_unnichat: "no Unnichat",
};

function inPlatform(origin: ProviderConversionRuleOriginDto): string {
  return (
    platformLocatives[origin] ?? `na ${platformNames[origin] ?? "plataforma"}`
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "nunca";
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

export function rotateConfirmText(origin: ProviderConversionRuleOriginDto): string {
  return `O endereço atual para de funcionar na hora. Depois, cole o novo endereço ${inPlatform(origin)}: até lá, nenhum evento desta regra é recebido.`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
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
      {state === "copied" ? "Copiado" : state === "failed" ? "Copie manualmente" : label}
    </button>
  );
}

function SetupSteps({
  origin,
  rule,
  capabilities,
}: {
  origin: ProviderConversionRuleOriginDto;
  rule: ProviderConversionRuleDto;
  capabilities?: ProviderConversionRuleCapabilitiesDto | null;
}) {
  if (origin === "automation_payt") {
    // The Payt panel already carries the setup steps: list them only once.
    return (
      <PaytSetupPanel
        eventName={rule.conversionRule.eventName}
        beta={originBetaEvents(origin, capabilities ?? null).includes(
          rule.conversionRule.eventName,
        )}
      />
    );
  }
  if (origin === "automation_umbler") {
    return (
      <>
        <ol className="integration-steps">
          <li>No Umbler Talk, crie uma ação HTTP (POST) na automação que marca a conversão.</li>
          <li>Cole o endereço da regra no campo de URL. Não precisa de cabeçalho extra.</li>
          <li>Cole o corpo abaixo e ligue os campos do contato e da conversa.</li>
        </ol>
        <UmblerAutomationPayloadPanel eventName={rule.conversionRule.eventName} />
      </>
    );
  }
  if (origin === "automation_unnichat") {
    return (
      <UnnichatAutomationSetupPanel
        eventLabel={ruleEventLabel(rule.conversionRule.eventName)}
      />
    );
  }
  return null;
}

const singleUrlProviders: Partial<
  Record<ProviderConversionRuleOriginDto, IntegrationEndpointProviderDto>
> = {
  automation_payt: "payt",
  automation_unnichat: "unnichat",
  automation_umbler: "umbler",
};

/**
 * Fase 5.3: a URL nova da regra (URL única da Payt ou URL do evento no
 * Unnichat e na Umbler, válida para todos os números).
 */
function SingleUrlSection({
  rule,
  origin,
  canManage,
  licenseLocked,
  integrationEndpoint,
  actions,
}: {
  rule: ProviderConversionRuleDto;
  origin: ProviderConversionRuleOriginDto;
  canManage: boolean;
  licenseLocked: boolean;
  integrationEndpoint: IntegrationEndpointDto | null;
  actions: SingleUrlActions;
}) {
  const provider = singleUrlProviders[origin]!;
  const [created, setCreated] = useState<IntegrationEndpointDto | null>(null);
  const [removed, setRemoved] = useState(false);
  const endpoint = removed ? null : (created ?? integrationEndpoint);
  const eventName = rule.conversionRule.eventName;
  const label =
    provider === "payt"
      ? "URL única da Payt (todas as regras e números)"
      : `URL do evento “${ruleEventLabelForOrigin(origin, eventName)}” (todos os números)`;

  return (
    <section className="conversion-endpoint-single-url" aria-label="URL nova">
      <h3>{provider === "payt" ? "URL única" : "URL por evento"}</h3>
      {endpoint ? (
        <IntegrationUrlBox
          key={endpoint.id}
          endpoint={endpoint}
          label={label}
          canManage={canManage}
          licenseLocked={licenseLocked}
          actions={actions}
          onRemoved={() => {
            setCreated(null);
            setRemoved(true);
          }}
        />
      ) : canManage ? (
        <>
          <EnsureUrlButton
            provider={provider}
            eventName={provider === "payt" ? null : eventName}
            ensure={actions.ensure}
            label={provider === "payt" ? "Gerar URL única" : "Gerar URL do evento"}
            disabled={licenseLocked}
            onReady={(next) => {
              setRemoved(false);
              setCreated(next);
            }}
          />
          {licenseLocked ? (
            <p className="action-note warn" role="note">
              {singleUrlLicenseLockedNote}
            </p>
          ) : null}
        </>
      ) : (
        <p className="action-note">
          Ainda não há URL gerada. Peça a quem gerencia integrações para gerar.
        </p>
      )}
    </section>
  );
}

/**
 * Estado da URL antiga (a própria da regra) e "Desativar URL antiga", com
 * confirmação: o que a plataforma ainda mandar por ela deixa de ser recebido.
 * Dá para reativar.
 */
function LegacyUrlSwitch({
  ruleId,
  provider,
  disabled,
  lastDeliveryAt,
  canManage,
  licenseLocked,
  setPublicUrl,
  onChanged,
}: {
  ruleId: string;
  provider: IntegrationEndpointProviderDto;
  disabled: boolean;
  lastDeliveryAt: string | null;
  canManage: boolean;
  licenseLocked: boolean;
  setPublicUrl: SingleUrlActions["setPublicUrl"];
  onChanged: (disabled: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sameThing = provider === "payt" ? "uma venda" : "um evento";

  async function apply(next: boolean) {
    setPending(true);
    setConfirming(false);
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    formData.set("disabled", String(next));
    const result = await setPublicUrl(formData).catch(() => null);
    setPending(false);
    setMessage(result?.message ?? "Não deu para alterar agora.");
    if (result?.ok) onChanged(next);
  }

  return (
    <div className="conversion-endpoint-legacy">
      <p className="action-note">
        {disabled
          ? "A URL antiga desta regra está desativada: a regra só recebe pela URL nova."
          : `A URL antiga desta regra ainda funciona (último recebimento por ela: ${formatDateTime(lastDeliveryAt)}). Depois de colar a URL nova na plataforma, apague a antiga lá e desative aqui; ${sameThing} que chegue pelas duas é enviado à Meta uma vez só.`}
      </p>
      {canManage && confirming ? (
        <div className="conversion-inline-confirm" role="alert">
          <p>{disableLegacyUrlConfirmText(provider)}</p>
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
              onClick={() => void apply(true)}
              disabled={pending || licenseLocked}
            >
              Desativar URL antiga
            </button>
          </div>
        </div>
      ) : canManage ? (
        <button
          className="button ghost"
          type="button"
          disabled={pending || licenseLocked}
          onClick={() => (disabled ? void apply(false) : setConfirming(true))}
        >
          {disabled ? "Reativar URL antiga" : "Desativar URL antiga"}
        </button>
      ) : null}
      {canManage && licenseLocked ? (
        <p className="action-note warn" role="note">
          {singleUrlLicenseLockedNote}
        </p>
      ) : null}
      {message ? (
        <p className="action-note" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Address of an automation rule (Umbler): when it was last
 * called, how to set it up and "Gerar novo endereço" (the old one stops
 * working; the new one is shown once). The new address is held by the
 * screen (`freshUrl`) until the operator says "Já copiei", so switching
 * tabs, refreshing the list or remounting never loses it.
 */
export function RuleEndpoint({
  rule,
  origin,
  canManage,
  rotateAction,
  freshUrl = null,
  capabilities = null,
  onRotated,
  onDismiss,
  integrationEndpoint = null,
  singleUrlActions,
  urlsCanManage = canManage,
  licenseLocked = false,
}: {
  /** Fase 5.3: a URL única/por evento desta regra (sem a chave). */
  integrationEndpoint?: IntegrationEndpointDto | null;
  singleUrlActions?: SingleUrlActions;
  /** Quem gerencia integrações (mesmo com a licença bloqueada). */
  urlsCanManage?: boolean;
  licenseLocked?: boolean;
  capabilities?: ProviderConversionRuleCapabilitiesDto | null;
  rule: ProviderConversionRuleDto;
  origin: ProviderConversionRuleOriginDto;
  canManage: boolean;
  rotateAction: RuleAction;
  freshUrl?: string | null;
  onRotated: (url: string) => void;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newUrl = freshUrl;
  const where = inPlatform(origin);
  const endpoint = rule.endpoint;
  const singleUrlProvider = singleUrlProviders[origin];
  const singleUrl = Boolean(singleUrlActions) && Boolean(singleUrlProvider);
  const [legacyClosed, setLegacyClosed] = useState(
    Boolean(endpoint?.publicUrlDisabledAt),
  );
  // Regra criada já para a URL nova (URL própria fechada e nunca chamada): não
  // há URL antiga que valha mencionar.
  const legacyNeverUsed =
    Boolean(endpoint?.publicUrlDisabledAt) && !endpoint?.lastDeliveryAt;

  async function rotate() {
    if (pending) return;
    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    try {
      const result = await rotateAction(formData);
      if (result.ok && result.oneTimeSecret) {
        onRotated(result.oneTimeSecret.webhookUrl);
      } else {
        setError(result.message);
      }
    } catch {
      setError(
        "Não deu para confirmar se um novo endereço foi gerado. Se a plataforma parar de enviar eventos, gere um novo endereço e cole de novo.",
      );
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  return (
    <div className="conversion-endpoint">
      {singleUrl && singleUrlActions ? (
        <SingleUrlSection
          rule={rule}
          origin={origin}
          canManage={urlsCanManage}
          licenseLocked={licenseLocked}
          integrationEndpoint={integrationEndpoint}
          actions={singleUrlActions}
        />
      ) : null}
      {singleUrl && singleUrlActions && singleUrlProvider && endpoint && !legacyNeverUsed ? (
        <section
          className="conversion-endpoint-legacy-section"
          aria-label="URL antiga desta regra"
        >
          <h3>URL antiga desta regra</h3>
          <LegacyUrlSwitch
            ruleId={rule.id}
            provider={singleUrlProvider}
            disabled={legacyClosed}
            lastDeliveryAt={endpoint.lastDeliveryAt}
            canManage={urlsCanManage}
            licenseLocked={licenseLocked}
            setPublicUrl={singleUrlActions.setPublicUrl}
            onChanged={setLegacyClosed}
          />
        </section>
      ) : null}
      {singleUrl && (legacyClosed || legacyNeverUsed) && !newUrl ? null : (
      <>
      <dl className="conversion-flow-summary">
        <div>
          <dt>Último evento recebido</dt>
          <dd>{formatDateTime(endpoint?.lastDeliveryAt ?? null)}</dd>
        </div>
        <div>
          <dt>Endereço gerado de novo em</dt>
          <dd>{endpoint?.rotatedAt ? formatDateTime(endpoint.rotatedAt) : "nunca foi trocado"}</dd>
        </div>
      </dl>

      {newUrl ? (
        <div className="conversion-fresh-url" role="status">
          <p className="action-note warn">
            Novo endereço gerado: o anterior já parou de funcionar. Ele só
            aparece agora; copie e cole {where}.
          </p>
          <div className="conversion-webhook-url">
            <label className="conversion-field">
              <span className="field-label">Novo endereço (exibido uma única vez)</span>
              <input
                readOnly
                value={newUrl}
                data-presentation-sensitive-field="true"
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <CopyButton value={newUrl} label="Copiar endereço" />
          </div>
          <button className="button primary" type="button" onClick={onDismiss}>
            <Check size={15} aria-hidden="true" />
            Já copiei
          </button>
        </div>
      ) : (
        <p className="action-note">
          Por segurança, o endereço só aparece uma vez, quando é criado. Se você
          perdeu, gere um novo e cole de novo {where}.
        </p>
      )}

      {error ? (
        <p className="action-note warn" role="alert">
          {error}
        </p>
      ) : null}

      {canManage && endpoint && !newUrl ? (
        confirming ? (
          <div className="conversion-inline-confirm" role="alert">
            <p>{rotateConfirmText(origin)}</p>
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
                onClick={() => void rotate()}
                disabled={pending}
              >
                {pending ? "Gerando..." : "Gerar novo endereço"}
              </button>
            </div>
          </div>
        ) : (
          <button className="button" type="button" onClick={() => setConfirming(true)}>
            <RefreshCw size={15} aria-hidden="true" />
            Gerar novo endereço
          </button>
        )
      ) : null}

      {!endpoint ? (
        <p className="action-note warn">Esta regra não tem um endereço ativo.</p>
      ) : null}
      </>
      )}

      <section className="conversion-endpoint-setup" aria-label={`Como configurar ${where}`}>
        <h3>Como configurar {where}</h3>
        {singleUrl && singleUrlProvider ? (
          <>
            <ol className="integration-steps">
              {singleUrlSetupSteps(
                singleUrlProvider,
                rule.conversionRule.eventName,
              ).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {origin === "automation_umbler" ? (
              <UmblerAutomationPayloadPanel
                eventName={rule.conversionRule.eventName}
              />
            ) : origin === "automation_unnichat" ? (
              <UnnichatWebhookBody />
            ) : null}
          </>
        ) : (
          <SetupSteps origin={origin} rule={rule} capabilities={capabilities} />
        )}
      </section>
    </div>
  );
}
