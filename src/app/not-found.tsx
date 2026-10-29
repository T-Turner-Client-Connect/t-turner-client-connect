import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="font-serif text-6xl font-bold text-navy-900">404</p>
        <h1 className="mt-2 text-2xl font-bold">Page not found</h1>
        <p className="mt-2 text-slate-600">The page doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <Link href="/welcome" className="mt-5 inline-block rounded-lg bg-navy-900 px-4 py-2 font-semibold text-white">Go to sign in</Link>
      </div>
    </main>
  );
}
