import type { Metadata } from "next";
import { Activity } from "@/components/activity/feed";
import { activityPageInput } from "@/lib/activity/window";
import { walletHref } from "@/lib/address";
import { walletMetadata } from "@/lib/site-metadata";
export const dynamic = "force-dynamic";
export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { address } = await params;
  const query = activityPageInput(await searchParams);
  if (!query)
    return (
      <main className="page">
        <div className="state-inline" role="alert">
          <strong>Invalid activity filters.</strong>
          <p>Use an explicit UTC date range and a valid page cursor.</p>
          <a
            className="button"
            href={walletHref(address, "activity")}
          >
            Reset filters
          </a>
        </div>
      </main>
    );
  return <Activity address={address} {...query} />;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  return walletMetadata((await params).address, "activity");
}
