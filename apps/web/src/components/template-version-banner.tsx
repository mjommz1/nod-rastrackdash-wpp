import {
  getTemplateVersionBannerData,
  type TemplateVersionState,
} from "../lib/template-version";
import {
  shortSha,
  TEMPLATE_UPDATE_GUIDE_URL,
} from "../lib/template-version-format";
import { TemplateUpdateNotice } from "./template-update-notice";

/**
 * Server component for the student backoffice: tells the platform owner
 * whether this instance tracks the template's `main`. Renders nothing for
 * anyone else (see getTemplateVersionBannerData). The comparison itself runs
 * in the API — the browser never talks to GitHub.
 */
export async function TemplateVersionBanner() {
  const data = await getTemplateVersionBannerData();

  if (!data) {
    return null;
  }

  return <TemplateVersionStatus userId={data.userId} version={data.version} />;
}

export function TemplateVersionStatus({
  userId,
  version,
}: {
  userId: string;
  version: TemplateVersionState;
}) {
  if (version.status === "behind") {
    return (
      <TemplateUpdateNotice
        deployedSha={version.deployedSha}
        latestMainSha={version.latestMainSha}
        userId={userId}
      />
    );
  }

  if (version.status === "current") {
    return (
      <p className="template-version-current">
        <span className="status-chip neutral">
          Versão instalada <code>{shortSha(version.deployedSha)}</code>
        </span>
      </p>
    );
  }

  return (
    <div className="feedback-banner neutral template-version-banner" role="status">
      <div className="template-version-banner-copy">
        <strong>Não foi possível verificar atualizações</strong>
        {version.reason === "missing_deployed_sha" ? (
          <span>
            O build desta instância não conseguiu confirmar o commit instalado
            (código-fonte sem metadados Git ou com alterações locais), então não
            dá para comparar com a versão mais recente. Isso não significa que
            ela esteja atualizada.
          </span>
        ) : (
          <span>
            A verificação não pôde ser concluída agora. Isso não significa que
            a instância esteja atualizada — confira manualmente pelo guia.
            {version.deployedSha ? (
              <>
                {" "}
                Versão instalada: <code>{shortSha(version.deployedSha)}</code>.
              </>
            ) : null}
          </span>
        )}
        <a href={TEMPLATE_UPDATE_GUIDE_URL} rel="noopener noreferrer" target="_blank">
          Ver guia de atualização
          <span className="sr-only"> (abre em nova aba)</span>
        </a>
      </div>
    </div>
  );
}
