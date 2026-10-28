import { AppHeader } from "@/components/app-header";
import { normalizeAddress } from "@/lib/address";
export default async function WalletLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  if (normalizeAddress(address) !== address)
    return (
      <>
        <AppHeader search />
        <main className="page">
          <div className="empty-state">
            <strong>That Solana address isn’t valid.</strong>Check the address
            and try another search.
          </div>
        </main>
      </>
    );
  return (
    <>
      <AppHeader search />
      {children}
    </>
  );
}
