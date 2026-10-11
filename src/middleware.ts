import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";
import { NextResponse } from "next/server";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  // Integration routes enforce their own bearer-token authentication.
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/integrations/n8n") ||
    pathname.startsWith("/order"); // customer-facing QR menu, no login
  const isAuthed = !!req.auth;

  if (!isAuthed && !isPublic && !pathname.startsWith("/api/auth")) {
    const url = new URL("/login", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  // Edge middleware cannot check live account status. Keep login reachable when
  // server auth rejects an otherwise unexpired JWT after an account is disabled.
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|brand/|favicon.ico).*)"],
};
