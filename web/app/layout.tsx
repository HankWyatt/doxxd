import type { Metadata } from "next";
import { WalletConnectProvider } from "@/components/wallet-connect/provider";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { actionsEnabledFromEnv } from "@/lib/actions/enabled";
import { siteMetadata } from "@/lib/site-metadata";
import "./globals.css";
export const metadata: Metadata = siteMetadata;
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
