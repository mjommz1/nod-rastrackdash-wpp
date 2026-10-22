import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { apiBaseUrl } from "../../../../lib/api";

// Filters that pick the leads, plus the format and the privacy toggle. Page and
// page size are left out on purpose: the file holds every match.
const exportQueryParams = [
  "format",
  "maskSensitive",
  "search",
  "status",
  "eventName",
  "label",
  "campaignId",
  "adSetId",
  "adId",
  "attribution",
  "since",
  "until",
  // Novos (default), "returning" or "repeat": the file follows the list's base.
  "base",
] as const;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = new URLSearchParams();

  exportQueryParams.forEach((param) => {
    const value = url.searchParams.get(param);

    if (value) {
      params.set(param, value);
    }
  });

  const response = await fetch(`${apiBaseUrl}/leads/export?${params}`, {
    credentials: "include",
    headers: {
      ...(await cookieHeader()),
    },
    cache: "no-store",
    // A cancelled download stops the API too.
    signal: request.signal,
  });

  if (!response.ok) {
    return NextResponse.json(
      { message: await errorMessage(response) },
      { status: response.status },
    );
  }

  // The body is passed through as a stream so a large file never sits whole
  // in this server's memory.
  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type":
        response.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition":
        response.headers.get("Content-Disposition") ??
        'attachment; filename="leads.csv"',
      "Cache-Control": "no-store",
    },
  });
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message) {
      return body.message;
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }

  return "Nao foi possivel exportar os leads";
}

async function cookieHeader(): Promise<Record<string, string>> {
  try {
    const value = (await cookies()).toString();

    return value ? { Cookie: value } : {};
  } catch {
    return {};
  }
}
