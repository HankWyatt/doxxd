import { Portfolio } from "@/components/wallet/portfolio";
import { actionsEnabledFromEnv } from "@/lib/actions/enabled";
export const dynamic = "force-dynamic";
export default async function WalletPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return (
    <Portfolio
      address={address}
      actionsEnabled={actionsEnabledFromEnv(process.env)}
    />
  );
}
