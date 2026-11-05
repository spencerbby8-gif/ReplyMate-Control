import { resolveConfigForClient } from "@/lib/config/versioning";
import { jsonError, newRequestId } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Remote configuration delivery.
 *
 * Public by design and safe to be so: it serves a **published** snapshot of
 * non-sensitive configuration keys. Sensitive keys are excluded when the release
 * is built, not filtered at read time, so there is no code path that could leak
 * one by accident.
 *
 * The response is versioned. A client that receives `release: null` must fall
 * back to its own built-in defaults — which is what an empty-but-200 response
 * would have pretended away.
 */
export async function GET(request: Request) {
  const requestId = newRequestId();
  const url = new URL(request.url);
  const appVersion = url.searchParams.get("appVersion");

  if (appVersion !== null && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(appVersion)) {
    return jsonError("appVersion must look like 1.5.9.", 400, "invalid_input", requestId);
  }

  const resolved = await resolveConfigForClient(appVersion);

  if (!resolved) {
    return Response.json(
      {
        data: {
          release: null,
          values: null,
          instruction:
            "No configuration release is published for this client version. Use the built-in defaults compiled into the app.",
        },
        requestId,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    {
      data: {
        release: {
          version: resolved.releaseVersion,
          publishedAt: resolved.publishedAt,
          minAppVersion: resolved.minAppVersion,
        },
        values: resolved.values,
      },
      requestId,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
