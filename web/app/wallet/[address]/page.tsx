import type { Metadata } from "next";
import { Portfolio } from "@/components/wallet/portfolio";
import { walletMetadata } from "@/lib/site-metadata";
export const dynamic = "force-dynamic";
export default async function WalletPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <Portfolio address={address} />;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  return walletMetadata((await params).address, "portfolio");
}
