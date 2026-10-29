import Image from "next/image";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-navy-50 to-white px-4 py-10">
      <div className="w-full max-w-md">
        <Image src="/brand/logo-full.png" alt="TTurner Client Connect" width={640} height={545} priority className="mx-auto mb-6 h-auto w-56" />
        <div className="rounded-2xl border border-navy-100 border-t-4 border-t-gold-500 bg-white p-6 shadow-sm sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs text-slate-500">Private system for T. Turner &amp; Associates, LLC staff.</p>
      </div>
    </main>
  );
}
