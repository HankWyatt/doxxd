import { Bookmark } from "lucide-react";
import { AddressSearch } from "./address-search";
export function AppHeader({ search = false }: { search?: boolean }) {
  return (
    <header className="site-header">
      <a href="/" className="brand" aria-label="Doxxd home">
        <span className="brand-mark" aria-hidden="true">
          d
        </span>
        doxxd<span className="brand-dot">.</span>
      </a>
      {search && (
        <div className="header-search">
          <AddressSearch />
        </div>
      )}
      <nav className="header-meta" aria-label="Site">
        <a href="/watchlist" className="header-watchlist"><Bookmark size={13} /><span>Watchlist</span></a>
        <a href="/demo" className="header-link">
          Explore demo
        </a>
        <span className="network">
          <i />
          Solana
        </span>
      </nav>
    </header>
  );
}
