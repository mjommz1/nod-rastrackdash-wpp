import {
  CreditCard,
  KanbanSquare,
  MessageSquareText,
  ShoppingBag,
  Tag,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { RuleLogo as RuleLogoView, RuleOriginId } from "./conversion-origins";

const originIcons: Record<RuleOriginId, LucideIcon> = {
  message_phrase: MessageSquareText,
  structured_catalog: ShoppingBag,
  whatsapp_label: Tag,
  automation_umbler: Webhook,
  automation_unnichat: Webhook,
  automation_payt: CreditCard,
  kommo: KanbanSquare,
  pipedrive: KanbanSquare,
};

/**
 * Platform logo of a rule origin (same tiles as the Integrations hub), or
 * the origin icon when the rule is not tied to one platform (e.g. a phrase
 * rule for every number). Decorative: the origin is always written next to it.
 */
export function RuleLogo({
  logo,
  origin,
  size = "default",
}: {
  logo: RuleLogoView | null;
  origin: RuleOriginId;
  size?: "default" | "small";
}) {
  const className = `integration-logo conversion-logo${size === "small" ? " is-small" : ""}`;

  if (logo) {
    return (
      <span className={`${className} on-${logo.surface}`} aria-hidden="true">
        <img src={logo.src} alt="" />
      </span>
    );
  }

  const Icon = originIcons[origin];

  return (
    <span className={`${className} is-icon`} aria-hidden="true">
      <Icon size={size === "small" ? 16 : 20} />
    </span>
  );
}
