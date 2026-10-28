import type { Metadata } from "next";
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
      <body>{children}</body>
    </html>
  );
}
