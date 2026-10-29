import type { CampaignChannel, CampaignPurpose, Channel } from "@prisma/client";
import { ineligibilityReason, type ActiveSuppression, type EligibilityInput } from "@/lib/consent";
import { formatPhone } from "@/lib/normalize";

type ConsentLike = EligibilityInput["personConsents"][number] & { contactId: string | null };

export type AudienceClient = {
  id: string;
  displayName: string;
  email: string | null;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  archivedAt: Date | null;
  taxReturnDerived: boolean;
  consentRecords: ConsentLike[];
  contacts: {
    id: string;
    name: string;
    email: string | null;
    emailNormalized: string | null;
    phoneNormalized: string | null;
  }[];
};

export type Recipient = {
  key: string;
  clientId: string;
  contactId: string | null;
  name: string;
  clientName: string;
  channel: Channel;
  address: string;
  addressDisplay: string;
};

export type ExcludedRecipient = {
  clientId: string;
  contactId: string | null;
  name: string;
  clientName: string;
  channel: Channel | null;
  addressDisplay: string | null;
  reason: string;
  manual: boolean;
};

export type RecipientResolution = {
  eligible: Recipient[];
  excluded: ExcludedRecipient[];
  selectedClientCount: number;
};

export function channelsFor(channel: CampaignChannel): Channel[] {
  return channel === "BOTH" ? ["EMAIL", "SMS"] : [channel];
}

/**
 * Turns a campaign's selected clients into the exact list of messages that
 * would be sent, with the reason for every exclusion.
 *
 * - Manual exclusions remove a client from this campaign only.
 * - Each client's primary details and every additional contact are considered.
 * - Addresses are de-duplicated per channel, so a shared email or phone
 *   number gets one message, not one per client.
 */
export function resolveRecipients(args: {
  channel: CampaignChannel;
  purpose: CampaignPurpose;
  clients: AudienceClient[];
  manualExclusions: Map<string, string | null>;
  suppressions: Map<string, ActiveSuppression[]>; // key: `${channel}:${address}`
  now?: Date;
}): RecipientResolution {
  const eligible: Recipient[] = [];
  const excluded: ExcludedRecipient[] = [];
  const claimed = new Map<string, Recipient>();
  const clients = [...args.clients].sort((a, b) => a.displayName.localeCompare(b.displayName));

  for (const client of clients) {
    if (args.manualExclusions.has(client.id)) {
      const note = args.manualExclusions.get(client.id);
      excluded.push({
        clientId: client.id,
        contactId: null,
        name: client.displayName,
        clientName: client.displayName,
        channel: null,
        addressDisplay: null,
        reason: note ? `Removed from this campaign: ${note}` : "Removed from this campaign",
        manual: true,
      });
      continue;
    }

    const clientConsents = client.consentRecords.filter((r) => r.contactId === null);
    const people = [
      { contactId: null as string | null, name: client.displayName, email: client.emailNormalized, phone: client.phoneNormalized },
      ...client.contacts.map((c) => ({ contactId: c.id, name: c.name, email: c.emailNormalized, phone: c.phoneNormalized })),
    ];

    for (const channel of channelsFor(args.channel)) {
      for (const person of people) {
        const address = channel === "EMAIL" ? person.email : person.phone;
        // Additional contacts without an address on this channel are just skipped.
        if (!address && person.contactId) continue;
        const display = channel === "EMAIL" ? address : formatPhone(address);
        const base = {
          clientId: client.id,
          contactId: person.contactId,
          name: person.name,
          clientName: client.displayName,
          channel,
          addressDisplay: display ?? null,
        };
        const reason = ineligibilityReason({
          channel,
          purpose: args.purpose,
          address,
          archived: client.archivedAt !== null,
          taxReturnDerived: client.taxReturnDerived,
          personConsents: client.consentRecords.filter((r) => r.contactId === person.contactId),
          clientConsents,
          suppressions: address ? args.suppressions.get(`${channel}:${address}`) ?? [] : [],
          now: args.now,
        });
        if (reason) {
          excluded.push({ ...base, reason, manual: false });
          continue;
        }
        const key = `${channel}:${address}`;
        const first = claimed.get(key);
        if (first) {
          excluded.push({ ...base, reason: `Same ${channel === "EMAIL" ? "email" : "number"} as ${first.name} — sent once`, manual: false });
          continue;
        }
        const recipient: Recipient = { ...base, key, address: address!, addressDisplay: display! };
        claimed.set(key, recipient);
        eligible.push(recipient);
      }
    }
  }

  return { eligible, excluded, selectedClientCount: clients.length };
}
