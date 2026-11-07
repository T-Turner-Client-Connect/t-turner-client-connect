import { Eye } from "lucide-react";

type Login = { id: string; name: string; email: string; role: string; signedUp: boolean };

/**
 * The one thing View as Client adds to the client's screen: a slim, always-visible bar saying
 * whose portal this is, that it is read-only, which login it shows (switchable), and Exit. A client
 * with no portal login is labelled "Simulated view" on every screen size: it isn't an exact login.
 * The style block shifts the client's own fixed sidebar and phone top bar below it.
 */
export function ViewAsClientBanner({ clientId, clientName, loginId, logins }: { clientId: string; clientName: string; loginId: string | null; logins: Login[] }) {
  const login = logins.find((l) => l.id === loginId) ?? null;
  return (
    <>
      <style>{`.vac-preview{padding-top:2.5rem}.vac-preview [data-testid="portal-sidebar"]{top:2.5rem}.vac-preview [data-testid="portal-topbar"]{top:2.5rem}`}</style>
      <div role="status" className="fixed inset-x-0 top-0 z-[60] flex h-10 items-center gap-2 border-b-2 border-gold-500 bg-gold-100 px-3 text-sm text-navy-950 sm:gap-3 sm:px-4" data-testid="view-as-client-banner">
        <Eye className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-semibold">
          Viewing as {clientName}
          {!login && <span className="ml-1.5 rounded bg-navy-900 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white" data-testid="preview-simulated">Simulated view</span>}
          <span className="hidden font-normal sm:inline">{login ? ` · login: ${login.name}` : " · no portal login yet, so this shows what an owner login would see, not an actual client's sign-in"}</span>
          {" "}— read-only
        </span>
        {logins.length > 1 && (
          <details className="relative shrink-0" data-testid="preview-login-picker">
            <summary className="cursor-pointer list-none rounded-md px-2 py-1 font-semibold underline decoration-gold-600 underline-offset-2 [&::-webkit-details-marker]:hidden">Switch login</summary>
            <ul className="absolute right-0 top-8 z-[61] w-64 rounded-lg border border-ivory-200 bg-white p-1 shadow-lg">
              {logins.map((l) => (
                <li key={l.id}>
                  <a href={`/view-as-client/${clientId}?as=${l.id}`} aria-current={l.id === loginId ? "true" : undefined} className="block rounded-md px-3 py-2 hover:bg-gold-50 aria-[current=true]:bg-navy-900 aria-[current=true]:text-white">
                    <span className="block font-semibold">{l.name}</span>
                    <span className="block text-xs opacity-80">{l.role === "OWNER" ? "Owner" : "Authorized contact"}{l.signedUp ? "" : " · not signed up yet"}</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a route handler that clears the preview cookie: a full navigation, never prefetched */}
        <a href="/view-as-client/exit" className="shrink-0 rounded-md bg-navy-900 px-3 py-1 font-semibold text-white" data-testid="preview-exit">Exit</a>
      </div>
    </>
  );
}
