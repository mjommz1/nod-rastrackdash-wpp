"use client";

import type { WhatsappConnectionDto } from "@wpptrack/shared";
import {
  Copy,
  Pencil,
  RefreshCw,
  Stethoscope,
  Trash2,
  Webhook,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import type {
  WhatsappConnectionEditData,
  WhatsappConnectionEditResult,
  WhatsappProviderActionResult,
  WhatsappReceiverSecret,
} from "./whatsapp-provider-actions";

type WhatsappProviderAction = (
  formData: FormData,
) => Promise<WhatsappProviderActionResult>;

type WhatsappProviderLoadEditAction = (
  connectionId: string,
) => Promise<WhatsappConnectionEditResult>;

type ProviderId = "uazapi_byo" | "nod_api" | "waha" | "zapi";

const secretFieldLabel: Record<ProviderId, string> = {
  uazapi_byo: "Token",
  waha: "API key",
  zapi: "Token",
  nod_api: "Instance token",
};

const receiverInstructionText: Record<ProviderId, string> = {
  uazapi_byo: "Cole esta URL completa no campo URL do webhook da Uazapi",
  waha: "Cole esta URL completa no campo de Webhook da WAHA",
  zapi: "Cole esta URL completa no campo de webhook da Z-API",
  nod_api: "Cole esta URL completa no campo de webhook do NOD API",
};

const providerCards: Array<{
  id: ProviderId;
  title: string;
  ingestion: string;
  pending: boolean;
}> = [
  {
    id: "uazapi_byo",
    title: "Uazapi (BYO)",
    ingestion: "Receptor e parser da Uazapi disponíveis para configuração.",
    pending: false,
  },
  {
    id: "nod_api",
    title: "NOD API",
    ingestion:
      "Em breve: novas conexões ainda não estão disponíveis; as existentes continuam gerenciáveis.",
    pending: true,
  },
  {
    id: "waha",
    title: "WAHA",
    ingestion:
      "Em breve: novas conexões ainda não estão disponíveis; as existentes continuam gerenciáveis.",
    pending: true,
  },
  {
    id: "zapi",
    title: "Z-API",
    ingestion:
      "Em breve: novas conexões ainda não estão disponíveis; as existentes continuam gerenciáveis.",
    pending: true,
  },
];

export type WhatsappProviderId = ProviderId;

export function WhatsappProviderPanel({
  connections: allConnections,
  provider: scopedProvider,
  canManage,
  createAction,
  testAction,
  rotateAction,
  editAction,
  loadEditAction,
  deleteAction,
  licenseLocked = false,
  allowCreate = true,
}: {
  connections: WhatsappConnectionDto[];
  /**
   * Scopes the panel to one provider (Integrations hub modal): only its
   * connections and status are shown and the create form is fixed to it.
   */
  provider?: ProviderId;
  canManage: boolean;
  createAction: WhatsappProviderAction;
  testAction: WhatsappProviderAction;
  rotateAction: WhatsappProviderAction;
  editAction: WhatsappProviderAction;
  loadEditAction: WhatsappProviderLoadEditAction;
  deleteAction: WhatsappProviderAction;
  /**
   * Client-side hint only (the API stays the authority with HTTP 423): while
   * the license is locked every write control is disabled.
   */
  licenseLocked?: boolean;
  /** False for "Em breve" providers: existing connections stay manageable. */
  allowCreate?: boolean;
}) {
  const titleId = useId();
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId>(
    scopedProvider ?? "uazapi_byo",
  );
  const connections = scopedProvider
    ? allConnections.filter(
        (connection) => connection.provider === scopedProvider,
      )
    : allConnections;
  const visibleCards = scopedProvider
    ? providerCards.filter((card) => card.id === scopedProvider)
    : providerCards;
  const scopedTitle = visibleCards[0]?.title;
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<WhatsappProviderActionResult | null>(
    null,
  );
  const [receiver, setReceiver] = useState<WhatsappReceiverSecret | null>(null);
  const [receiverProvider, setReceiverProvider] = useState<ProviderId | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editData, setEditData] = useState<WhatsappConnectionEditData | null>(
    null,
  );
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    setPending("create");
    setNotice(null);

    try {
      const result = await createAction(new FormData(form));
      setNotice(result);
      if (result.ok) {
        form.reset();
        router.refresh();
      } else {
        clearCredentials(form);
      }
    } catch {
      clearCredentials(form);
      setNotice({
        ok: false,
        message: "Nao foi possivel salvar a conexao WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  async function runAction(
    key: string,
    action: WhatsappProviderAction,
    connectionId: string,
  ) {
    if (pending) return;
    setPending(key);
    setNotice(null);
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    try {
      const result = await action(formData);
      setNotice(result);
      if (result.receiverSecret) {
        setReceiver(result.receiverSecret);
        setReceiverProvider(
          connections.find((connection) => connection.id === connectionId)
            ?.provider ?? null,
        );
        setCopied(false);
      }
      if (result.ok) router.refresh();
    } catch {
      setNotice({
        ok: false,
        message: "Nao foi possivel concluir a acao da conexao WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  async function openEdit(connectionId: string) {
    if (pending) return;
    if (editing === connectionId) {
      closeEdit();
      return;
    }
    setPending(`edit-load-${connectionId}`);
    setNotice(null);
    try {
      const result = await loadEditAction(connectionId);
      if (result.ok) {
        setEditData(result.data);
        setEditing(connectionId);
      } else {
        setNotice(result);
      }
    } catch {
      setNotice({
        ok: false,
        message: "Nao foi possivel carregar os dados da conexao.",
      });
    } finally {
      setPending(null);
    }
  }

  function closeEdit() {
    setEditing(null);
    setEditData(null);
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !editing) return;
    const form = event.currentTarget;
    const connectionId = editing;
    setPending(`edit-${connectionId}`);
    setNotice(null);

    try {
      const result = await editAction(new FormData(form));
      setNotice(result);
      clearCredentials(form);
      if (result.ok) {
        closeEdit();
        router.refresh();
      }
    } catch {
      clearCredentials(form);
      setNotice({
        ok: false,
        message: "Nao foi possivel atualizar a conexao WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  function openDeleteConfirm(connectionId: string) {
    if (pending) return;
    if (deleteConfirmId === connectionId) {
      closeDeleteConfirm();
      return;
    }
    closeEdit();
    setNotice(null);
    setDeleteConfirmId(connectionId);
    setDeleteConfirmText("");
  }

  function closeDeleteConfirm() {
    setDeleteConfirmId(null);
    setDeleteConfirmText("");
  }

  async function confirmDelete(connection: WhatsappConnectionDto) {
    if (pending) return;
    const key = `delete-${connection.id}`;
    setPending(key);
    setNotice(null);
    const formData = new FormData();
    formData.set("connectionId", connection.id);
    try {
      const result = await deleteAction(formData);
      setNotice(result);
      if (result.ok) {
        closeDeleteConfirm();
        router.refresh();
      }
    } catch {
      setNotice({
        ok: false,
        message: "Nao foi possivel excluir a conexao WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  async function copyWebhookUrl() {
    try {
      if (!receiver) return;
      await navigator.clipboard.writeText(receiver.webhookUrl);
      setCopied(true);
    } catch {
      setNotice({
        ok: false,
        message: "Nao foi possivel copiar automaticamente.",
      });
    }
  }

  return (
    <section
      className="surface-panel"
      aria-labelledby={titleId}
    >
      <div className="inbound-webhook-heading">
        <div>
          <span className="eyebrow">Conexoes WhatsApp</span>
          <h2 id={titleId}>
            {scopedProvider
              ? `Conexoes ${scopedTitle ?? scopedProvider}`
              : "Provedores e receivers"}
          </h2>
          <p className="muted">
            As credenciais ficam somente na API. O token do receiver e salvo
            apenas como hash no servidor.
          </p>
        </div>
      </div>

      <fieldset className="license-lock-scope" disabled={licenseLocked}>
      {licenseLocked && canManage ? (
        <p className="action-note warn" role="status">
          Licença bloqueada: criar, testar, editar e excluir conexões está
          indisponível. Verifique /backoffice/license.
        </p>
      ) : null}
      {scopedProvider ? null : (
        <p className="muted">
          Usa Umbler Talk ou Gupshup? Essas plataformas sao configuradas no
          bloco de webhooks logo abaixo, e nao nesta lista.
        </p>
      )}

      <div
        className="inbound-counter-grid"
        data-testid="whatsapp-provider-statuses"
      >
        {visibleCards.map((card) => (
          <div className="inbound-counter" key={card.id}>
            <strong>{card.title}</strong>
            <p className={card.pending ? "muted action-note warn" : "muted"}>
              {card.ingestion}
            </p>
          </div>
        ))}
      </div>

      {!allowCreate ? (
        <p className="action-note" role="status">
          Novas conexões deste provedor estão em breve. As conexões que você já
          tem continuam disponíveis para testar, editar e excluir.
        </p>
      ) : null}

      {canManage && allowCreate ? (
        <form
          className="inbound-webhook-create"
          onSubmit={submitCreate}
          onInvalid={(event) => clearCredentials(event.currentTarget)}
        >
          {scopedProvider ? (
            <input type="hidden" name="provider" value={scopedProvider} />
          ) : (
            <label>
              <span className="field-label">Provedor</span>
              <select
                name="provider"
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as ProviderId)
                }
              >
                {providerCards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="field-label">Nome</span>
            <input name="name" required minLength={1} maxLength={120} />
          </label>
          <label>
            <span className="field-label">Nome exibido</span>
            <input name="displayName" maxLength={120} />
          </label>
          {provider !== "nod_api" ? (
            <label>
              <span className="field-label">URL da API</span>
              <input name="baseUrl" type="url" required />
            </label>
          ) : null}
          {provider === "waha" ? (
            <label>
              <span className="field-label">API key</span>
              <input name="apiKey" type="password" required />
            </label>
          ) : null}
          {provider === "uazapi_byo" || provider === "zapi" ? (
            <label>
              <span className="field-label">Token</span>
              <input name="token" type="password" required />
            </label>
          ) : null}
          {provider === "uazapi_byo" ||
          provider === "zapi" ||
          provider === "nod_api" ? (
            <label>
              <span className="field-label">Instance ID</span>
              <input name="instanceId" required={provider !== "uazapi_byo"} />
            </label>
          ) : null}
          {provider === "nod_api" ? (
            <label>
              <span className="field-label">Instance token</span>
              <input name="instanceToken" type="password" required />
            </label>
          ) : null}
          {provider === "waha" ? (
            <label>
              <span className="field-label">Sessao</span>
              <input name="session" />
            </label>
          ) : null}
          <button
            className="button primary"
            type="submit"
            disabled={pending === "create"}
          >
            <Webhook size={16} aria-hidden="true" />
            {pending === "create" ? "Salvando..." : "Salvar conexao"}
          </button>
        </form>
      ) : null}

      {receiver ? (
        <div
          className="inbound-webhook-secret"
          data-presentation-sensitive-action="true"
        >
          <div>
            <span className="micro-label">Exibido uma unica vez</span>
            <strong>
              {receiverProvider
                ? receiverInstructionText[receiverProvider]
                : "Cole esta URL completa no campo de webhook do provider"}
            </strong>
          </div>
          <input
            readOnly
            value={receiver.webhookUrl}
            aria-label="URL completa do receiver WhatsApp"
            data-presentation-sensitive-field="true"
          />
          <button
            className="button"
            type="button"
            onClick={() => void copyWebhookUrl()}
          >
            <Copy size={16} aria-hidden="true" />
            {copied ? "Copiada" : "Copiar URL completa"}
          </button>
        </div>
      ) : null}
      {notice ? (
        <div
          className={`feedback-banner ${notice.ok ? "success" : "warn"}`}
          role={notice.ok ? "status" : "alert"}
        >
          {notice.message}
        </div>
      ) : null}

      <div className="inbound-connection-list">
        {connections.length === 0 ? (
          <p className="muted">Nenhuma conexao de provider configurada.</p>
        ) : (
          connections.map((connection) => (
            <div className="inbound-connection-body" key={connection.id}>
              <strong>{connection.displayName ?? connection.name}</strong>
              <span>
                {providerCards.find((card) => card.id === connection.provider)
                  ?.title ?? connection.provider}
              </span>
              {canManage ? (
                <div className="inbound-connection-actions">
                  <button
                    className="button"
                    type="button"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void runAction(
                        `test-${connection.id}`,
                        testAction,
                        connection.id,
                      )
                    }
                  >
                    <Stethoscope size={15} aria-hidden="true" />
                    {pending === `test-${connection.id}`
                      ? "Testando..."
                      : "Testar"}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void runAction(
                        `rotate-${connection.id}`,
                        rotateAction,
                        connection.id,
                      )
                    }
                  >
                    <RefreshCw size={15} aria-hidden="true" />
                    Gerar receiver
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={Boolean(pending) && editing !== connection.id}
                    onClick={() => void openEdit(connection.id)}
                  >
                    <Pencil size={15} aria-hidden="true" />
                    {pending === `edit-load-${connection.id}`
                      ? "Carregando..."
                      : "Editar"}
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    disabled={
                      Boolean(pending) && deleteConfirmId !== connection.id
                    }
                    onClick={() => openDeleteConfirm(connection.id)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    Excluir
                  </button>
                </div>
              ) : null}

              {canManage && deleteConfirmId === connection.id ? (
                <div
                  className="inbound-connection-delete-confirm"
                  data-testid={`whatsapp-connection-delete-confirm-${connection.id}`}
                >
                  <p className="action-note warn">
                    Isso desativa a conexao e ela deixa de aparecer na lista.
                    Para confirmar, digite o nome{" "}
                    <strong>{connection.name}</strong> abaixo.
                  </p>
                  <label>
                    <span className="field-label">Nome da conexao</span>
                    <input
                      autoComplete="off"
                      value={deleteConfirmText}
                      onChange={(event) =>
                        setDeleteConfirmText(event.target.value)
                      }
                      aria-label={`Confirmar exclusao da conexao ${connection.name} digitando o nome`}
                    />
                  </label>
                  <div className="inbound-connection-actions">
                    <button
                      className="button danger"
                      type="button"
                      disabled={
                        pending === `delete-${connection.id}` ||
                        deleteConfirmText.trim() !== connection.name
                      }
                      onClick={() => void confirmDelete(connection)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                      {pending === `delete-${connection.id}`
                        ? "Excluindo..."
                        : "Confirmar exclusao"}
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={closeDeleteConfirm}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : null}

              {canManage && editing === connection.id && editData ? (
                <form
                  className="inbound-webhook-create"
                  data-testid={`whatsapp-connection-edit-${connection.id}`}
                  onSubmit={submitEdit}
                  onInvalid={(event) => clearCredentials(event.currentTarget)}
                >
                  <input
                    type="hidden"
                    name="connectionId"
                    value={connection.id}
                  />
                  <input
                    type="hidden"
                    name="provider"
                    value={connection.provider}
                  />
                  <label>
                    <span className="field-label">Provedor</span>
                    <input
                      value={
                        providerCards.find(
                          (card) => card.id === connection.provider,
                        )?.title ?? connection.provider
                      }
                      disabled
                      readOnly
                    />
                  </label>
                  <label>
                    <span className="field-label">Nome</span>
                    <input
                      name="name"
                      defaultValue={editData.name}
                      required
                      minLength={1}
                      maxLength={120}
                    />
                  </label>
                  <label>
                    <span className="field-label">Nome exibido</span>
                    <input
                      name="displayName"
                      defaultValue={editData.displayName ?? ""}
                      maxLength={120}
                    />
                  </label>
                  {connection.provider !== "nod_api" ? (
                    <label>
                      <span className="field-label">URL da API</span>
                      <input
                        name="baseUrl"
                        type="url"
                        defaultValue={editData.baseUrl ?? ""}
                        required
                      />
                    </label>
                  ) : null}
                  {connection.provider === "uazapi_byo" ||
                  connection.provider === "zapi" ||
                  connection.provider === "nod_api" ? (
                    <label>
                      <span className="field-label">Instance ID</span>
                      <input
                        name="instanceId"
                        defaultValue={editData.instanceId ?? ""}
                        required={connection.provider !== "uazapi_byo"}
                      />
                    </label>
                  ) : null}
                  {connection.provider === "waha" ? (
                    <label>
                      <span className="field-label">Sessao</span>
                      <input
                        name="session"
                        defaultValue={editData.session ?? ""}
                      />
                    </label>
                  ) : null}
                  <label>
                    <span className="field-label">
                      {secretFieldLabel[connection.provider]}
                    </span>
                    <input
                      name="secret"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Deixe em branco para manter atual"
                    />
                  </label>
                  <div className="inbound-connection-actions">
                    <button
                      className="button primary"
                      type="submit"
                      disabled={pending === `edit-${connection.id}`}
                    >
                      {pending === `edit-${connection.id}`
                        ? "Salvando..."
                        : "Salvar alteracoes"}
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={closeEdit}
                    >
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ))
        )}
      </div>
      </fieldset>
    </section>
  );
}

function clearCredentials(form: HTMLFormElement) {
  form
    .querySelectorAll<HTMLInputElement>('input[type="password"]')
    .forEach((input) => {
      input.value = "";
    });
}
