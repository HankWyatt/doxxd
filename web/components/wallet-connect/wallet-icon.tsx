import type { ConnectedWallet } from "@/lib/actions/wallet-session";
import { avatarStyle } from "@/lib/portfolio/headline";

/** The wallet's own icon, or the generated avatar when it has none. */
export function WalletIcon({ wallet, size }: { wallet: ConnectedWallet; size: number }) {
  if (!wallet.walletIcon)
    return (
      <span
        className="account-avatar"
        style={{ ...avatarStyle(wallet.address), width: size, height: size }}
        aria-hidden="true"
      />
    );
  // Wallet icons are data URIs supplied by the wallet; next/image cannot optimize them.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="account-icon" src={wallet.walletIcon} alt="" width={size} height={size} />;
}
