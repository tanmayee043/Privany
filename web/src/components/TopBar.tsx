import type { ReactNode } from "react";

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex min-h-14 max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
        <a href="#/" className="flex items-center gap-2.5 text-[19px] font-extrabold tracking-tight text-white no-underline">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="6" fill="#fff" />
            <rect x="7" y="7" width="18" height="3" fill="#111" />
            <rect x="7" y="13" width="18" height="1.5" fill="#111" />
            <rect x="7" y="17.5" width="12" height="1.5" fill="#111" />
            <rect x="7" y="22" width="18" height="3" fill="#111" />
          </svg>
          Privany
        </a>
        {children}
      </div>
    </header>
  );
}
