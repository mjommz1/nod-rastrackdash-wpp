import type {
  StructuredCatalogMatchReasonCodeDto,
  StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";

type ProviderCatalogTestResultProps = {
  result: StructuredCatalogTestMessageResultDto;
};

const classificationLabels: Record<
  StructuredCatalogTestMessageResultDto["classification"],
  string
> = {
  recognized: "Variante reconhecida",
  awaiting_data: "Aguardando dados",
  review_required: "Revisao necessaria",
  ignored: "Mensagem ignorada",
};

const reasonLabels: Record<StructuredCatalogMatchReasonCodeDto, string> = {
  matched: "Combinacao e preco conferidos.",
  rule_inactive: "A regra esta pausada.",
  catalog_inactive: "O catalogo esta inativo.",
  missing_attribute: "A mensagem nao contem todos os atributos.",
  ambiguous_attribute: "Um atributo apareceu com mais de um valor.",
  unknown_combination: "A combinacao nao existe no catalogo.",
  ambiguous_variant: "Mais de uma variante corresponde a mensagem.",
  missing_price: "Nenhum preco foi encontrado na mensagem.",
  ambiguous_price: "Mais de um preco foi encontrado na mensagem.",
  price_mismatch: "O preco da mensagem difere do catalogo.",
  trigger_missing: "A frase gatilho nao foi encontrada.",
  empty_template: "O template ainda nao possui dados preenchidos.",
  awaiting_data: "A mensagem ainda nao contem os dados da compra.",
  incomplete_item: "Um produto esta sem todos os atributos.",
  invalid_quantity: "A quantidade informada nao e valida.",
};

export function ProviderCatalogTestResult({
  result,
}: ProviderCatalogTestResultProps) {
  const currency = result.currency ?? "BRL";
  const calculatedValueCents =
    result.calculatedValueCents ?? result.parsedValueCents;

  return (
    <section
      className={`provider-catalog-test-result classification-${result.classification}`}
      aria-live="polite"
      role="status"
    >
      <header className="provider-catalog-test-result-heading">
        <div>
          <span className="micro-label">Decisao do simulador</span>
          <strong>{classificationLabels[result.classification]}</strong>
        </div>
        <span className="provider-catalog-test-result-reason">
          {reasonLabels[result.reasonCode]}
        </span>
      </header>

      {result.matchedTriggerPhrase ? (
        <div className="provider-catalog-test-trigger">
          <span>Frase gatilho</span>
          <strong>{result.matchedTriggerPhrase}</strong>
        </div>
      ) : null}

      {result.parsedAttributes.length > 0 ? (
        <dl className="provider-catalog-test-attributes">
          {result.parsedAttributes.map((attribute) => (
            <div key={attribute.key}>
              <dt>{attribute.label}</dt>
              <dd>{attribute.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {result.items.length > 0 ? (
        <div className="provider-catalog-test-items">
          <span className="micro-label">
            {result.items.length === 1 ? "Item extraido" : "Itens extraidos"}
          </span>
          {result.items.map((item) => (
            <div className="provider-catalog-test-item" key={item.position}>
              <div>
                <strong>{item.contentName ?? `Item ${item.position}`}</strong>
                <span>
                  {item.parsedAttributes
                    .map(
                      (attribute) =>
                        `${attribute.label}: ${attribute.value}`,
                    )
                    .join(" / ") || "Atributos incompletos"}
                </span>
              </div>
              <span className="provider-catalog-test-quantity">
                {item.quantity} un.
              </span>
              <span className="provider-catalog-test-item-value">
                {item.subtotalValueCents
                  ? formatMoney(item.subtotalValueCents, currency)
                  : "Valor pendente"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {calculatedValueCents || result.observedPaymentValueCents ? (
        <dl className="provider-catalog-test-values">
          {calculatedValueCents ? (
            <div>
              <dt>Valor pelo catalogo</dt>
              <dd>{formatMoney(calculatedValueCents, currency)}</dd>
            </div>
          ) : null}
          {result.observedPaymentValueCents ? (
            <div>
              <dt>Valor informado na mensagem</dt>
              <dd>
                {formatMoney(result.observedPaymentValueCents, currency)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
