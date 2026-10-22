"use client";

import { ChevronDown, Download, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";
import {
  leadExportHref,
  type LeadExportFormat,
  type LeadFilterValues,
} from "./lead-filter-params";

const formatOptions: Array<{
  format: LeadExportFormat;
  label: string;
  hint: string;
}> = [
  { format: "xlsx", label: "Excel (.xlsx)", hint: "Abre direto no Excel" },
  {
    format: "csv",
    label: "CSV (.csv)",
    hint: "Texto separado por ponto e vírgula",
  },
];

const genericError = "Não foi possível gerar a planilha. Tente novamente.";

function downloadName(response: Response, format: LeadExportFormat): string {
  const header = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/u.exec(header);

  return match?.[1] ?? `leads.${format}`;
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message) {
      return body.message;
    }
  } catch {
    // Not JSON: use the generic message.
  }

  return genericError;
}

/**
 * "Exportar": downloads every lead of the applied filters (not just the page
 * on screen) as Excel or CSV.
 */
export function LeadExportMenu({ applied }: { applied: LeadFilterValues }) {
  const presentationMode = usePresentationMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [busyFormat, setBusyFormat] = useState<LeadExportFormat | null>(null);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const busy = busyFormat !== null;

  useEffect(() => {
    if (!open) {
      return;
    }

    function close(event: Event) {
      if (
        event.type === "keydown" &&
        (event as KeyboardEvent).key !== "Escape"
      ) {
        return;
      }

      if (
        event.type === "pointerdown" &&
        rootRef.current?.contains(event.target as Node)
      ) {
        return;
      }

      setOpen(false);
    }

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  async function download(format: LeadExportFormat) {
    setOpen(false);
    setBusyFormat(format);
    setMessage(null);

    try {
      const response = await fetch(
        leadExportHref(applied, format, presentationMode),
        { credentials: "include", cache: "no-store" },
      );

      if (!response.ok) {
        setMessage({ tone: "error", text: await failureMessage(response) });
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = downloadName(response, format);
      document.body.appendChild(link);
      link.click();
      link.remove();
      // The browser needs a moment to start reading the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage({
        tone: "ok",
        text: presentationMode
          ? "Planilha baixada com nomes e telefones ocultos."
          : "Planilha baixada.",
      });
    } catch {
      setMessage({ tone: "error", text: genericError });
    } finally {
      setBusyFormat(null);
    }
  }

  return (
    <div className="lead-export" ref={rootRef}>
      <button
        className="button ghost lead-export-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        {busy ? (
          <LoaderCircle
            aria-hidden="true"
            className="lead-export-spinner"
            size={16}
            strokeWidth={2}
          />
        ) : (
          <Download aria-hidden="true" size={16} strokeWidth={2} />
        )}
        {busy ? "Gerando planilha..." : "Exportar"}
        {busy ? null : (
          <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
        )}
      </button>

      {open ? (
        <div className="lead-export-menu" id={menuId} role="menu">
          <p>Baixa todos os leads dos filtros aplicados, não só esta página.</p>
          {formatOptions.map((option) => (
            <button
              key={option.format}
              type="button"
              role="menuitem"
              onClick={() => void download(option.format)}
            >
              <strong>{option.label}</strong>
              <span>{option.hint}</span>
            </button>
          ))}
          {presentationMode ? (
            <small>
              &quot;Ocultar dados&quot; está ativo: nomes, telefones e campanhas
              saem ocultos.
            </small>
          ) : null}
        </div>
      ) : null}

      <span
        className={`lead-export-message${message?.tone === "error" ? " error" : ""}`}
        role={message?.tone === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {message?.text ?? ""}
      </span>
    </div>
  );
}
