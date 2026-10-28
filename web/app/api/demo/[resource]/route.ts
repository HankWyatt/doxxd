import { readFixture } from "@/lib/fixtures/wallet";
import { fixtureScenarios, type FixtureScenario } from "@/lib/dmnd/contracts";
import { isResource } from "@/lib/dmnd/resources";
import { parseResourceQuery } from "@/lib/dmnd/query";
import { resourceResponse } from "@/lib/dmnd/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ resource: string }> },
) {
  const { resource } = await params;
  const query = new URL(request.url).searchParams;
  const scenario = query.get("scenario") ?? "complete";
  if (
    !isResource(resource) ||
    !fixtureScenarios.includes(scenario as FixtureScenario) ||
    query.getAll("scenario").length > 1
  )
    return resourceResponse({ ok: false, kind: "invalid_input" });
  query.delete("scenario");
  const parsed = parseResourceQuery(resource, query);
  return parsed === null
    ? resourceResponse({ ok: false, kind: "invalid_input" })
    : resourceResponse(
        readFixture(resource, scenario as FixtureScenario, parsed),
      );
}
