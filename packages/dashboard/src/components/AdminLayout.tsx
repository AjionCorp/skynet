"use client";

import type { ReactNode, ComponentType } from "react";
import { RefreshCw, ArrowLeft } from "lucide-react";

export interface AdminLayoutPage {
  href: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface AdminLayoutProps {
  /** Current user info. If undefined, no user badge is shown. */
  user?: { email?: string | null };
  /** Navigation pages to display in the admin header and sub-nav. */
  pages?: AdminLayoutPage[];
  /** Href for the back arrow link. Defaults to "/". */
  backHref?: string;
  /** Label for the back arrow link. Defaults to "Dashboard". */
  backLabel?: string;
  /** The Link component to use for navigation (e.g. Next.js Link). Defaults to a plain <a> tag. */
  linkComponent?: ComponentType<{ href: string; className?: string; children: ReactNode }>;
  children: ReactNode;
}

export function AdminLayout({
  user,
  pages = [],
  backHref = "/",
  backLabel = "Dashboard",
  linkComponent,
  children,
}: AdminLayoutProps) {
  // Use the provided Link component or fall back to a plain <a> tag
  const Link = linkComponent ?? (({ href, className, children: c }: { href: string; className?: string; children: ReactNode }) => (
    <a href={href} className={className}>{c}</a>
  ));

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Admin header */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-8 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <Link
            href={backHref}
            className="flex items-center gap-2 text-sm text-zinc-400 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            {backLabel}
          </Link>
          <span className="text-zinc-700">/</span>
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-white">Admin</span>
          </div>
          {pages.length > 0 && (
            <>
              <span className="text-zinc-700">/</span>
              <nav className="flex items-center gap-1">
                {pages.map((page) => (
                  <Link
                    key={page.href}
                    href={page.href}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
                  >
                    {page.icon && <page.icon className="h-3.5 w-3.5" />}
                    {page.label}
                  </Link>
                ))}
              </nav>
            </>
          )}
        </div>
        {user && (
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-700 text-xs font-semibold text-white">
              {user.email?.charAt(0).toUpperCase() ?? "U"}
            </div>
            <span className="text-sm text-zinc-400">{user.email}</span>
          </div>
        )}
      </header>

      {/* Sub-nav tabs */}
      {pages.length > 0 && (
        <nav className="border-b border-zinc-800 bg-zinc-950/60 px-8 backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl gap-1">
            {pages.map((page) => (
              <Link
                key={page.href}
                href={page.href}
                className="flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-xs font-medium text-zinc-500 transition hover:border-zinc-600 hover:text-zinc-300"
              >
                {page.icon && <page.icon className="h-3.5 w-3.5" />}
                {page.label}
              </Link>
            ))}
          </div>
        </nav>
      )}

      <main className="mx-auto max-w-7xl p-8">{children}</main>
    </div>
  );
}
