import { Activity } from "@/components/activity/feed";
import { activityPageInput } from "@/lib/activity/window";
import { actionsEnabledFromEnv } from "@/lib/actions/enabled";
import { walletHref } from "@/lib/address";
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
  return (
    <Activity
      address={address}
      actionsEnabled={actionsEnabledFromEnv(process.env)}
      {...query}
    />
  );
}
