"use client";

import { X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Short supporting line under the title. */
  description?: ReactNode;
  /** Visual shown before the title (e.g. a platform logo). */
  media?: ReactNode;
  children: ReactNode;
  /**
   * Keeps the content mounted (hidden) while closed. Use it when the content
   * owns state that must survive closing — e.g. a pending request lock or a
   * one-time URL shown after creating a connection.
   */
  keepMounted?: boolean;
  size?: "default" | "wide";
  className?: string;
  closeLabel?: string;
  id?: string;
};

/**
 * Small accessible modal: role="dialog" + aria-modal, labelled by its title,
 * focus moves inside on open, Tab/Shift+Tab stay inside, Escape and the
 * backdrop close it, and focus returns to the element that opened it.
 *
 * Rendered in place (no portal) so it also works in server-rendered markup.
 * Native <dialog> elements opened inside it keep handling their own focus
 * and Escape: this modal steps aside while one of them is open.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  media,
  children,
  keepMounted = false,
  size = "default",
  className,
  closeLabel = "Fechar",
  id,
}: ModalProps) {
  const generatedId = useId();
  const baseId = id ?? `modal-${generatedId.replace(/:/gu, "")}`;
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    const activeElement = document.activeElement;
    returnFocusRef.current =
      activeElement instanceof HTMLElement ? activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Escape closes even before focus has moved inside (or if it left).
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        dialogRef.current?.querySelector("dialog[open]")
      ) {
        return;
      }

      onCloseRef.current();
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(document.activeElement)) {
        dialog.focus();
      }
    });

    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown);
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target && target.isConnected) {
        target.focus();
      }
    };
  }, [open]);

  if (!open && !keepMounted) {
    return null;
  }

  function nativeDialogOpen(): boolean {
    return Boolean(dialogRef.current?.querySelector("dialog[open]"));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open || event.defaultPrevented || nativeDialogOpen()) {
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(focusableSelector),
    ).filter(
      (element) =>
        !element.closest("[hidden]") &&
        !element.closest("[inert]") &&
        element.getAttribute("aria-hidden") !== "true",
    );

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={`app-modal-layer${className ? ` ${className}` : ""}`}
      hidden={!open}
      data-state={open ? "open" : "closed"}
    >
      <div
        className="app-modal-backdrop"
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
      />
      <div
        ref={dialogRef}
        className={`app-modal app-modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        id={baseId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="app-modal-header">
          {media ? <div className="app-modal-media">{media}</div> : null}
          <div className="app-modal-heading">
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button
            className="app-modal-close"
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="app-modal-body">{children}</div>
      </div>
    </div>
  );
}
