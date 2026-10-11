import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";
import type { Role } from "@prisma/client";
import { currentSessionUser } from "@/lib/sessionUser";

declare module "next-auth" {
  interface User {
    sessionVersion: number;
    role: Role;
    organizationId: string;
    branchIds: string[];
  }
  interface Session {
    user: {
      id: string;
      email: string | null;
      name: string;
      role: Role;
      organizationId: string;
      branchIds: string[];
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    sessionVersion: number;
    id: string;
    role: Role;
    organizationId: string;
    branchIds: string[];
  }
}

const credentialsSchema = z.object({
  // Either an email (owner/manager accounts that have one) or a username (cashiers
  // created without one — see lib/users.ts) — the login form just calls this "identifier".
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        identifier: { label: "Username or email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const identifier = parsed.data.identifier.toLowerCase();
        const user = await prisma.user.findFirst({
          where: { OR: [{ email: identifier }, { username: identifier }] },
          include: { branches: true },
        });
        if (!user || !user.active) return null;

        const ok = await compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;

        // Fire-and-forget: a login log write should never block or fail the
        // actual login. This is the only place a login is ever recorded, so
        // losing this write silently (network blip, etc.) loses that one
        // event, but never breaks sign-in.
        prisma.loginEvent
          .create({ data: { organizationId: user.organizationId, userId: user.id } })
          .catch(() => {});

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          sessionVersion: user.sessionVersion,
          organizationId: user.organizationId,
          branchIds: user.branches.map((b) => b.branchId),
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id!;
        token.email = user.email!;
        token.name = user.name!;
        token.role = user.role;
        token.organizationId = user.organizationId;
        token.branchIds = user.branchIds;
        token.sessionVersion = user.sessionVersion;
      } else {
        const current = await currentSessionUser(token.id, token.sessionVersion ?? 0);
        if (!current) return null;
        Object.assign(token, current);
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        id: token.id,
        email: token.email!,
        name: token.name!,
        role: token.role,
        organizationId: token.organizationId,
        branchIds: token.branchIds,
      };
      return session;
    },
  },
});
