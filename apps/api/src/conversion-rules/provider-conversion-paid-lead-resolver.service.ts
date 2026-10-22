import { resolveCtwaLeadProof } from "./ctwa-lead-proof";
import { Inject, Injectable } from "@nestjs/common";
import type { ProviderConversionPaidLeadResolutionDto } from "@wpptrack/shared";
import {
  hashPhoneIdentity,
  hashPhoneIdentityVariants,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";

@Injectable()
export class ProviderConversionPaidLeadResolver {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(input: {
    workspaceId: string;
    phone: string | null | undefined;
    phoneCandidates?: readonly string[];
    channelId?: string;
    connectionId?: string;
    /**
     * Payt purchases arrive on a callback that is not itself the WhatsApp
     * entry connection. Accept the no-ad CTWA proof of ANY single verified
     * entry of this lead in the workspace (same rigor: materialized first-entry
     * receipt for the same lead, click and an authorized channel). The caller
     * must still bind the proof's channel to the rule scope.
     */
    ctwaProofAnyChannel?: boolean;
  }): Promise<ProviderConversionPaidLeadResolutionDto> {
    const phones = [input.phone, ...(input.phoneCandidates ?? [])];
    const phoneHashes = [
      ...new Set(
        phones
          .map((phone) => hashPhoneIdentity(phone ?? undefined))
          .filter((hash): hash is string => Boolean(hash)),
      ),
    ];
    if (phoneHashes.length === 0) {
      return {
        status: "missing_identity",
        reasonCode: "missing_contact_identity",
      };
    }

    // Exact forms first (unchanged behaviour). Only when none matches, try the
    // equivalent Brazilian forms (with/without 55 and the mobile 9th digit):
    // a lead stored as +55 82 9931-2477 is the buyer 82 99931-2477. More than
    // one DISTINCT lead in a tier stays ambiguous.
    let candidates = await this.findCandidates(input.workspaceId, phoneHashes);
    if (candidates.length === 0) {
      const exact = new Set(phoneHashes);
      const equivalentHashes = hashPhoneIdentityVariants(phones).filter(
        (hash) => !exact.has(hash),
      );
      if (equivalentHashes.length > 0) {
        candidates = await this.findCandidates(
          input.workspaceId,
          equivalentHashes,
        );
      }
    }

    if (candidates.length === 0) {
      return {
        status: "not_found",
        reasonCode: "paid_lead_not_found",
        candidateLeadId: null,
      };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        reasonCode: "paid_lead_ambiguous",
        candidateLeadIds: candidates.map((candidate) => candidate.id),
      };
    }

    const lead = candidates[0]!;
    const adId = lead.adId?.trim() || null;
    const ctwaClid = lead.ctwaClid?.trim() || null;
    // Verified CTWA entry proof (authorized pixel+page destination). For a
    // no-ad lead it is the only attribution; for a lead carrying an ad id
    // (e.g. an Unnichat ad hint) it is kept as the fallback destination when
    // no saved per-ad Meta route resolves at production time.
    const proof =
      lead.ctwaClid?.trim() && (input.connectionId || input.ctwaProofAnyChannel)
        ? await resolveCtwaLeadProof(this.prisma, {
            workspaceId: input.workspaceId,
            leadId: lead.id,
            phoneHash: lead.phoneHash,
            ctwaClid: lead.ctwaClid,
            channelId: input.channelId,
            connectionId: input.connectionId,
          })
        : null;
    if (!adId && proof)
      return {
        status: "resolved",
        reasonCode: "paid_lead_resolved",
        lead: {
          id: lead.id,
          phoneHash: lead.phoneHash,
          campaignId: null,
          adSetId: null,
          adId: null,
          ctwaClid: lead.ctwaClid!,
          ctwaDestination: proof,
        },
      };
    if (!adId || !ctwaClid) {
      return {
        status: "not_found",
        reasonCode: "paid_attribution_missing",
        candidateLeadId: lead.id,
      };
    }

    return {
      status: "resolved",
      reasonCode: "paid_lead_resolved",
      lead: {
        id: lead.id,
        phoneHash: lead.phoneHash,
        campaignId: lead.campaignId,
        adSetId: lead.adSetId,
        adId,
        ctwaClid,
        ...(proof ? { ctwaDestination: proof } : {}),
      },
    };
  }

  private findCandidates(workspaceId: string, phoneHashes: string[]) {
    return this.prisma.lead.findMany({
      where: {
        workspaceId,
        phoneHash:
          phoneHashes.length === 1 ? phoneHashes[0]! : { in: phoneHashes },
      },
      select: {
        id: true,
        phoneHash: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
      },
      take: 2,
    });
  }
}
