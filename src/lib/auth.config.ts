import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  // Roughly one shift. Server auth also reloads access from the database.
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isPublic = pathname.startsWith("/login");
      const isAuthApi = pathname.startsWith("/api/auth");
      if (isAuthApi) return true;
      if (isPublic) return true;
      return !!auth;
    },
  },
} satisfies NextAuthConfig;
