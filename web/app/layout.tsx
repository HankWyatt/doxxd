import type { Metadata } from "next";
import { WalletConnectProvider } from "@/components/wallet-connect/provider";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { actionsEnabledFromEnv } from "@/lib/actions/enabled";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Doxxd — Solana wallet explorer", template: "%s · Doxxd" },
  description:
    "A clearer view of any Solana wallet. Explore token holdings, DeFi positions, and activity.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* One wallet connection for the header and every page. The server
            decides once whether actions are on; when off, no wallet logic runs. */}
        <ActionsAvailabilityProvider enabled={actionsEnabledFromEnv(process.env)}>
          <WalletConnectProvider>{children}</WalletConnectProvider>
        </ActionsAvailabilityProvider>
      </body>
    </html>
  );
}
