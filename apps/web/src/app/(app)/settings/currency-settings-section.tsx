import {
  normalizeCurrencyCode,
  supportedCurrencyOptions,
  type AdAccountCurrencyDto,
  type AdAccountCurrencyListDto,
  type WorkspaceCurrencySettingsDto,
} from "@wpptrack/shared";
import { Coins } from "lucide-react";
import { BackofficeActionForm } from "../../../components/backoffice-action-form";
import { PendingSubmitButton } from "../../../components/pending-submit-button";
import { PresentationMask } from "../../../components/presentation-mask";
import { ConversionCurrencyForm } from "./conversion-currency-form";
import { saveAdAccountCurrencyAction } from "./currency-settings-actions";

const currencyNames: Record<string, string> = {
  BRL: "Real",
  USD: "Dólar",
  EUR: "Euro",
};

function currencyName(code: string): string {
  return currencyNames[code] ? `${currencyNames[code]} (${code})` : code;
}

/** "Usar a da Meta (USD)": a opção que remove a correção manual. */
export function metaCurrencyOptionLabel(account: AdAccountCurrencyDto): string {
  if (!account.detectedCurrency) {
    return "Usar a da Meta (não informada: BRL)";
  }

  return account.detectedCurrencySupported
    ? `Usar a da Meta (${account.detectedCurrency})`
    : `Usar a da Meta (${account.detectedCurrency} não suportada: BRL)`;
}

/**
 * Configurações -> Moeda:
 * - "Moeda das conversões": o que vai à Meta quando a venda e a regra não
 *   informam moeda; cada regra pode usar outra.
 * - Contas de anúncio: moeda detectada na Meta, com correção manual.
 * Somente leitura para quem não tem canManage (dono/admin alteram).
 */
export function CurrencySettingsSection({
  settings,
  accounts,
  sectionNumber,
}: {
  settings: WorkspaceCurrencySettingsDto | null;
  accounts: AdAccountCurrencyListDto | null;
  sectionNumber: string;
}) {
  const canManage = Boolean(settings?.canManage);
  const canManageAccounts = Boolean(accounts?.canManage);
  const accountRows = accounts?.accounts ?? [];
  const unsupported = accountRows.filter(
    (account) =>
      account.detectedCurrency !== null &&
      !account.detectedCurrencySupported &&
      account.currencyOverride === null,
  );
  const currentCurrency = normalizeCurrencyCode(settings?.conversionCurrency);

  return (
    <section
      className="settings-domain-section settings-currency-domain"
      id="configuracao-moeda"
      aria-labelledby="settings-currency-title"
    >
      <div className="settings-domain-heading">
        <span className="settings-domain-number" aria-hidden="true">
          {sectionNumber}
        </span>
        <div>
          <span className="eyebrow">Moeda</span>
          <h2 id="settings-currency-title">Moeda</h2>
          <p>
            Moeda do valor das conversões enviadas à Meta e moeda do
            investimento de cada conta de anúncio.
          </p>
        </div>
        <span className={`status-chip${settings ? "" : " warn"}`}>
          {settings
            ? `Conversões em ${settings.conversionCurrency}`
            : "Indisponível"}
        </span>
      </div>

      <div className="surface-panel currency-settings-panel">
        <div className="currency-settings-block">
          <span className="settings-automation-icon" aria-hidden="true">
            <Coins size={19} />
          </span>
          <div className="currency-settings-copy">
            <span className="eyebrow">Recebimento</span>
            <strong>Moeda das conversões</strong>
            <small>
              É a moeda enviada à Meta junto com o valor das conversões. Cada
              regra pode usar outra moeda. Plataformas de venda (Payt) e CRMs
              (Kommo, Pipedrive) usam a moeda da venda ou do negócio quando ela
              vier. Eventos já enviados não mudam.
            </small>
          </div>
          {!settings || !currentCurrency ? (
            <p className="muted">
              Não foi possível carregar a moeda das conversões.
            </p>
          ) : canManage ? (
            <ConversionCurrencyForm
              current={currentCurrency}
              supportedCurrencies={settings.supportedCurrencies}
            />
          ) : (
            <p className="currency-settings-readonly">
              <strong>{currencyName(settings.conversionCurrency)}</strong>
              <small>Somente o dono ou o admin altera a moeda.</small>
            </p>
          )}
        </div>

        <div className="currency-settings-accounts">
          <div className="currency-settings-copy">
            <span className="eyebrow">Investimento</span>
            <strong>Contas de anúncio</strong>
            <small>
              A moeda vem da Meta. Corrija aqui se a conta estiver errada: o
              investimento dessa conta passa a usar a moeda corrigida. Para
              remover a correção, escolha &quot;Usar a da Meta&quot;. Contas
              com moedas diferentes nunca são somadas.
            </small>
          </div>

          {unsupported.length > 0 ? (
            <div className="feedback-banner warn" role="status">
              <strong>Moeda da Meta não suportada</strong>
              <span>
                {unsupported.length === 1
                  ? "1 conta usa"
                  : `${unsupported.length} contas usam`}{" "}
                uma moeda fora de Real, Dólar e Euro. Os valores ficam em BRL
                até você escolher a moeda correta.
              </span>
            </div>
          ) : null}

          {!accounts ? (
            <p className="muted">
              Não foi possível carregar as contas de anúncio.
            </p>
          ) : accountRows.length === 0 ? (
            <p className="muted">
              Nenhuma conta de anúncio conectada. Conecte a Meta em Integrações.
            </p>
          ) : (
            <div className="table-wrap currency-accounts-table-wrap">
              <table className="currency-accounts-table">
                <thead>
                  <tr>
                    <th>Conta de anúncio</th>
                    <th>Moeda da Meta</th>
                    <th>Moeda usada</th>
                    <th>Correção manual</th>
                  </tr>
                </thead>
                <tbody>
                  {accountRows.map((account) => (
                    <tr
                      key={account.id}
                      data-account-id={account.adAccountId}
                      className={account.active ? undefined : "inactive"}
                    >
                      <td data-label="Conta de anúncio">
                        <strong>
                          <PresentationMask placeholder="Conta oculta">
                            {account.adAccountName}
                          </PresentationMask>
                        </strong>
                        <small>
                          <PresentationMask placeholder="BM oculto">
                            {account.businessName}
                          </PresentationMask>
                          {account.active ? "" : " · inativa"}
                        </small>
                      </td>
                      <td data-label="Moeda da Meta">
                        {account.detectedCurrency ?? "Não informada"}
                        {account.detectedCurrency &&
                        !account.detectedCurrencySupported ? (
                          <span className="status-chip warn currency-unsupported">
                            Não suportada
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Moeda usada">
                        <span className="tag currency-badge">
                          {account.effectiveCurrency}
                        </span>
                        {account.currencyOverride ? (
                          <small> corrigida</small>
                        ) : null}
                      </td>
                      <td data-label="Correção manual">
                        {canManageAccounts ? (
                          <BackofficeActionForm
                            action={saveAdAccountCurrencyAction}
                            className="currency-account-form"
                          >
                            <input
                              type="hidden"
                              name="accountId"
                              value={account.id}
                            />
                            <select
                              name="currencyOverride"
                              defaultValue={account.currencyOverride ?? ""}
                              aria-label={`Moeda da conta ${account.adAccountName}`}
                            >
                              <option value="">
                                {metaCurrencyOptionLabel(account)}
                              </option>
                              {supportedCurrencyOptions.map((option) => (
                                <option key={option.code} value={option.code}>
                                  {option.code}
                                </option>
                              ))}
                            </select>
                            <PendingSubmitButton
                              className="button ghost"
                              label="Salvar"
                              pendingLabel="Salvando..."
                            />
                          </BackofficeActionForm>
                        ) : (
                          <span>
                            {account.currencyOverride
                              ? `Corrigida para ${account.currencyOverride}`
                              : metaCurrencyOptionLabel(account)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
