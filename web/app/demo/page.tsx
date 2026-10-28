import { AppHeader } from "@/components/app-header";
import { Portfolio } from "@/components/wallet/portfolio";
import { fixtureScenarios, type FixtureScenario } from "@/lib/dmnd/contracts";
import { DEMO_ADDRESS } from "@/lib/fixtures/wallet";
import { Activity } from "@/components/activity/feed";
import { activityPageInput } from "@/lib/activity/window";
export const dynamic = "force-dynamic";
export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const scenario = query.scenario ?? "complete";
  if (
    typeof scenario !== "string" ||
    !fixtureScenarios.includes(scenario as FixtureScenario)
  )
    return (
      <>
        <AppHeader search />
        <main className="page">
          <p>Unknown demo scenario.</p>
        </main>
      </>
    );
  const mode = { kind: "demo" as const, scenario: scenario as FixtureScenario };
  if (query.tab === "activity") {
    const activity = activityPageInput(query);
    if (!activity)
      return (
        <>
          <AppHeader search />
          <main className="page">
            <p role="alert">Invalid activity filters.</p>
            <a className="button" href="/demo?tab=activity">
              Reset filters
            </a>
          </main>
        </>
      );
    return (
      <>
        <AppHeader search />
        <Activity address={DEMO_ADDRESS} mode={mode} {...activity} />
      </>
    );
  }
  return (
    <>
      <AppHeader search />
      <Portfolio address={DEMO_ADDRESS} mode={mode} />
    </>
  );
}
