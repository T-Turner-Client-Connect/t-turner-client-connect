import { Notice } from "@/components/ui";
import { MessagesPageView } from "@/components/portal/messages-view";
import { acknowledgeLetterAction, portalMessageAction } from "@/app/actions/portal";
import { portalViewer } from "@/lib/portal/viewer";
import { prisma } from "@/lib/prisma";
import { conversationsFor, markClientRead, portalConversations, portalThreadWhere, THREAD_INCLUDE } from "@/lib/services/messaging";
import { portalLettersForMessages, recordLetterViewed } from "@/lib/services/client-letters";

export const metadata = { title: "Messages" };

export default async function PortalMessages({ searchParams }: { searchParams: Promise<{ account?: string; c?: string; new?: string; view?: string }> }) {
  const sp = await searchParams;
  const v = await portalViewer("messages", sp.account);
  const { user, current, accounts, readOnly } = v;
  if (!current) return null;
  if (!current.canMessage) return <Notice>Messaging isn&apos;t enabled for your access to this account.</Notice>;
  const conversations = user ? await portalConversations(user, current.clientId) : await conversationsFor(current.clientId, null);
  const selected = sp.c ? conversations.find((c) => c.id === sp.c) : undefined;
  const thread = selected ? await prisma.message.findMany({ where: portalThreadWhere(selected.id), include: THREAD_INCLUDE, orderBy: { createdAt: "asc" } }) : [];
  // Opening a thread marks it read, and a client letter's first view is recorded — only by the
  // client's own login, never by View as Client.
  if (selected && user && !readOnly) await markClientRead(user, selected.id);
  const letters = selected && user ? await portalLettersForMessages(user, current.clientId, thread.map((m) => m.id)) : [];
  if (letters.length && user && !readOnly) await recordLetterViewed(user.id, current.clientId, { messageIds: letters.map((l) => l.messageId!) });
  const q = `account=${current.clientId}`;
  return (
    <MessagesPageView
      conversations={conversations}
      selected={selected}
      thread={thread}
      letters={letters}
      showAll={sp.view === "all"}
      clientName={current.client.businessName || current.client.displayName}
      multiAccount={accounts.length > 1}
      canUpload={current.canUpload}
      hrefFor={(extra) => `/client/messages?${q}${extra ? `&${extra}` : ""}`}
      linkFor={v.linkFor}
      send={v.act(portalMessageAction, current.clientId)}
      acknowledge={(id) => v.act(acknowledgeLetterAction, id)}
      readOnly={readOnly}
    />
  );
}
