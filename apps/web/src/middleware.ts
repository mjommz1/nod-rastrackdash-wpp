import { NextResponse, type NextRequest } from "next/server";

const protectedPrefixes = [
  "/overview",
  "/leads",
  "/reports",
  "/events",
  "/integrations",
  "/conversions",
  "/settings",
  "/backoffice",
];

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/settings/invites/accept") {
    return NextResponse.next();
  }

  const isProtected = protectedPrefixes.some((prefix) =>
    request.nextUrl.pathname.startsWith(prefix),
  );

  if (!isProtected) {
    return NextResponse.next();
  }

  const session = request.cookies.get("wpptrack_session")?.value;

  if (session) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-wpptrack-pathname", request.nextUrl.pathname);

    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set(
    "redirectTo",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/overview/:path*",
    "/leads/:path*",
    "/reports/:path*",
    "/events/:path*",
    "/integrations/:path*",
    "/conversions/:path*",
    "/settings/:path*",
    "/backoffice/:path*",
  ],
};
