"use client";

import { ArrowUpRight, Plug, Settings2 } from "lucide-react";
import Link from "next/link";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../../../../components/modal";
import { cardsForTab, type IntegrationCardView } from "./integration-cards";
import {
  integrationCategoryLabels,
  integrationDeepLinkFromHash,
  integrationProviderHash,
  integrationTabs,
  type IntegrationProviderId,
  type IntegrationTabId,
} from "./integration-registry";

export type IntegrationQuickLink = {
  label: string;
  href: string;
};

export type IntegrationsHubProps = {
  cards: IntegrationCardView[];
  /** Existing connect/manage UI for each provider, shown in its modal. */
  panels: Partial<Record<IntegrationProviderId, ReactNode>>;
  /** Extra shortcuts shown on active cards. */
  quickLinks?: Partial<Record<IntegrationProviderId, IntegrationQuickLink[]>>;
  /** Content shown at the top of a tab (notices, external sources). */
  tabIntro?: Partial<Record<IntegrationTabId, ReactNode>>;
  initialTab?: IntegrationTabId;
  initialProvider?: IntegrationProviderId | null;
  /**
   * Result of the last action (e.g. "Destino salvo"). Shown at the top of
   * `noticeProvider`'s modal while it is open, otherwise above the tabs —
   * never hidden behind a modal backdrop.
   */
  notice?: ReactNode;
  noticeProvider?: IntegrationProviderId | null;
};

function modalIdFor(id: IntegrationProviderId): string {
  return `integration-modal-${id}`;
}

function replaceHash(hash: string | null) {
  try {
    const { pathname, search } = window.location;
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}${search}${hash ? `#${hash}` : ""}`,
    );
  } catch {
    // History can be unavailable (sandboxed previews); the UI still works.
  }
}

export function IntegrationsHub({
  cards,
  panels,
  quickLinks = {},
  tabIntro = {},
  initialTab = "whatsapp",
  initialProvider = null,
  notice = null,
  noticeProvider = null,
}: IntegrationsHubProps) {
  const [activeTab, setActiveTab] = useState<IntegrationTabId>(initialTab);
  const [openProvider, setOpenProvider] =
    useState<IntegrationProviderId | null>(
      initialProvider && panels[initialProvider] !== undefined
        ? initialProvider
        : null,
    );
  const tabRefs = useRef<Partial<Record<IntegrationTabId, HTMLButtonElement>>>(
    {},
  );
  const panelsRef = useRef(panels);
  panelsRef.current = panels;

  const applyHash = useCallback((fromNavigation: boolean) => {
    const link = integrationDeepLinkFromHash(window.location.hash);

    if (link.tab) {
      setActiveTab(link.tab);
    }

    if (link.provider && panelsRef.current[link.provider] !== undefined) {
      setOpenProvider(link.provider);
    } else if (link.tab && fromNavigation) {
      // A link to a tab (e.g. "Ir para WhatsApp" inside a modal) shows it.
      setOpenProvider(null);
    }
  }, []);

  useEffect(() => {
    applyHash(false);
    const onHashChange = () => applyHash(true);
    window.addEventListener("hashchange", onHashChange);

    return () => window.removeEventListener("hashchange", onHashChange);
  }, [applyHash]);

  function selectTab(tab: IntegrationTabId, focus = false) {
    setActiveTab(tab);
    const definition = integrationTabs.find((item) => item.id === tab);
    replaceHash(definition?.hash ?? null);

    if (focus) {
      tabRefs.current[tab]?.focus();
    }
  }

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const last = integrationTabs.length - 1;
    let next: number | null = null;

    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;

    if (next !== null) {
      event.preventDefault();
      selectTab(integrationTabs[next].id, true);
    }
  }

  function openCard(card: IntegrationCardView) {
    setOpenProvider(card.id);
    replaceHash(integrationProviderHash(card.id));
  }

  function closeModal() {
    setOpenProvider(null);
    const definition = integrationTabs.find((item) => item.id === activeTab);
    replaceHash(definition?.hash ?? null);
  }

  const noticeInModal =
    notice !== null &&
    noticeProvider !== null &&
    openProvider === noticeProvider;

  return (
    <div className="integrations-hub">
      {notice !== null && !noticeInModal ? (
        <div className="integrations-hub-notice">{notice}</div>
      ) : null}
      <div
        className="integrations-hub-tabs"
        role="tablist"
        aria-label="Categorias de integração"
      >
        {integrationTabs.map((tab, index) => {
          const { active } = cardsForTab(cards, tab.id);
          const selected = tab.id === activeTab;

          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) tabRefs.current[tab.id] = element;
              }}
              className="integrations-hub-tab"
              type="button"
              role="tab"
              id={`integrations-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={tab.hash}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span>{tab.label}</span>
              {active.length > 0 ? (
                <span className="integrations-hub-tab-count">
                  <span aria-hidden="true">{active.length}</span>
                  <span className="sr-only">
                    {` ${active.length} ativa${active.length === 1 ? "" : "s"}`}
                  </span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {integrationTabs.map((tab) => {
        const { active, available } = cardsForTab(cards, tab.id);

        return (
          <section
            key={tab.id}
            className="integrations-hub-panel"
            role="tabpanel"
            id={tab.hash}
            aria-labelledby={`integrations-tab-${tab.id}`}
            hidden={tab.id !== activeTab}
            tabIndex={0}
          >
            <p className="integrations-hub-panel-intro">{tab.description}</p>
            {tabIntro[tab.id] ?? null}

            <section
              className="integrations-hub-group"
              aria-labelledby={`${tab.hash}-ativos`}
            >
              <h2 id={`${tab.hash}-ativos`}>Ativos</h2>
              {active.length > 0 ? (
                <ul className="integrations-hub-grid" role="list">
                  {active.map((card) => (
                    <li key={card.id}>
                      <IntegrationCard
                        card={card}
                        quickLinks={quickLinks[card.id] ?? []}
                        onOpen={() => openCard(card)}
                        hasPanel={panels[card.id] !== undefined}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="integrations-hub-empty">
                  Nenhuma integração ativa aqui ainda. Escolha uma abaixo para
                  conectar.
                </p>
              )}
            </section>

            <section
              className="integrations-hub-group"
              aria-labelledby={`${tab.hash}-disponiveis`}
            >
              <h2 id={`${tab.hash}-disponiveis`}>Disponíveis</h2>
              {available.length > 0 ? (
                <ul className="integrations-hub-grid" role="list">
                  {available.map((card) => (
                    <li key={card.id}>
                      <IntegrationCard
                        card={card}
                        quickLinks={[]}
                        onOpen={() => openCard(card)}
                        hasPanel={panels[card.id] !== undefined}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="integrations-hub-empty">
                  Tudo o que está disponível nesta categoria já está conectado.
                </p>
              )}
            </section>
          </section>
        );
      })}

      {cards.map((card) =>
        panels[card.id] !== undefined ? (
          <Modal
            key={card.id}
            id={modalIdFor(card.id)}
            open={openProvider === card.id}
            onClose={closeModal}
            keepMounted
            size="wide"
            title={card.name}
            description={card.description}
            media={
              <span
                className={`integration-logo integration-logo-modal on-${card.logoSurface}`}
              >
                <IntegrationLogoImage
                  src={card.logo}
                  initials={card.initials}
                />
              </span>
            }
          >
            {noticeInModal && card.id === noticeProvider ? (
              <div className="integrations-hub-notice in-modal">{notice}</div>
            ) : null}
            {panels[card.id]}
          </Modal>
        ) : null,
      )}
    </div>
  );
}

/**
 * Official or fallback artwork. If the file is missing (or fails to load,
 * including before hydration) the platform's initials are shown instead of a
 * broken image.
 */
function IntegrationLogoImage({
  src,
  initials,
}: {
  src: string;
  initials: string;
}) {
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const image = imageRef.current;

    if (image && image.complete && image.naturalWidth === 0) {
      setFailed(true);
    }
  }, [src]);

  if (failed) {
    return (
      <span className="integration-logo-initials" aria-hidden="true">
        {initials}
      </span>
    );
  }

  return (
    <img ref={imageRef} src={src} alt="" onError={() => setFailed(true)} />
  );
}

function IntegrationCard({
  card,
  quickLinks,
  onOpen,
  hasPanel,
}: {
  card: IntegrationCardView;
  quickLinks: IntegrationQuickLink[];
  onOpen: () => void;
  hasPanel: boolean;
}) {
  const isActive = card.state === "active";
  const chipTone =
    card.status.tone === "warn"
      ? " warn"
      : card.status.tone === "neutral"
        ? " neutral"
        : "";

  return (
    <article
      className={`integration-hub-card${isActive ? " is-active" : ""}`}
      data-integration={card.id}
      data-state={card.state}
      data-coming-soon={card.comingSoon ? "true" : undefined}
    >
      <button
        className="integration-hub-card-main"
        type="button"
        onClick={onOpen}
        disabled={!hasPanel || card.comingSoon}
        aria-haspopup="dialog"
        aria-controls={modalIdFor(card.id)}
        aria-label={
          card.comingSoon
            ? `${card.name}: em breve`
            : `${isActive ? "Gerenciar" : "Conectar"} ${card.name}`
        }
      >
        <span className={`integration-logo on-${card.logoSurface}`}>
          <IntegrationLogoImage src={card.logo} initials={card.initials} />
        </span>
        <span className="integration-hub-card-copy">
          <span className="integration-hub-card-category">
            {integrationCategoryLabels[card.category]}
          </span>
          <strong>{card.name}</strong>
          <span className="integration-hub-card-description">
            {card.description}
          </span>
        </span>
      </button>
      <div className="integration-hub-card-footer">
        <div className="integration-hub-card-status">
          <span className={`status-chip${chipTone}`}>{card.status.label}</span>
          {card.detail ? (
            <span className="integration-hub-card-detail">{card.detail}</span>
          ) : null}
        </div>
        {/* Visual cue only: the whole card is the button above. */}
        {card.comingSoon ? null : (
          <span
            className={`integration-hub-card-cta${isActive ? "" : " primary"}`}
            aria-hidden="true"
          >
            {isActive ? <Settings2 size={15} /> : <Plug size={15} />}
            {isActive ? "Gerenciar" : "Conectar"}
          </span>
        )}
        {quickLinks.length > 0 ? (
          <div className="integration-hub-card-links">
            {quickLinks.map((link) => (
              <Link
                className="integration-hub-card-link"
                href={link.href}
                key={link.href}
              >
                <ArrowUpRight size={14} aria-hidden="true" />
                {link.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
