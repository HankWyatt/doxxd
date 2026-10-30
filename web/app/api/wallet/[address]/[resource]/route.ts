import { serverClient } from "@/lib/dmnd/client.server";
import { isResource } from "@/lib/dmnd/resources";
import { parseResourceQuery } from "@/lib/dmnd/query";
import { resourceResponse } from "@/lib/dmnd/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string; resource: string }> },
) {
  const { address, resource } = await params;
  if (!isResource(resource))
    return resourceResponse({ ok: false, kind: "invalid_input" });
  const query = parseResourceQuery(resource, new URL(request.url).searchParams);
  if (query === null)
    return resourceResponse({ ok: false, kind: "invalid_input" });
  return resourceResponse(await serverClient().read(address, resource, query));
}
