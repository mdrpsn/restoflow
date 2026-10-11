"use client";

import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState, Suspense } from "react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await signIn("credentials", {
      identifier: String(form.get("identifier")),
      password: String(form.get("password")),
      redirect: false,
    });
    setPending(false);
    if (res?.error) {
      setError("Invalid username/email or password");
      return;
    }
    router.push(params.get("callbackUrl") || "/pos");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="login-form">
      <div>
        <div className="login-eyebrow"><span className="login-dot" /> STAFF WORKSPACE</div>
        <h1>Welcome back.</h1>
        <p className="login-intro">Sign in to run your shift at We Got Cha!</p>
      </div>
      <div className="login-fields">
      <div>
        <label className="label" htmlFor="identifier">
          Username or email
        </label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          required
          className="field"
          autoComplete="username"
          placeholder="Enter your username or email"
        />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          className="field"
          autoComplete="current-password"
          placeholder="Enter your password"
        />
      </div>
      </div>
      {error && (
        <p role="alert" className="login-error">
          {error}
        </p>
      )}
      <button type="submit" className="btn-primary login-submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"} <span aria-hidden="true">→</span>
      </button>
      <p className="login-help">Your account is managed by your store administrator.</p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="login-page">
      <div className="login-story">
        <div className="login-story-top"><span className="brand-mark">W<span>!</span></span><strong>We Got Cha!</strong></div>
        <div className="login-story-bottom"><span>YOUR STORE, IN SYNC</span><h2>Good service starts behind the scenes.</h2><p>Sales, stock, and your team, together in one place.</p></div>
      </div>
      <div className="login-panel">
        <div className="login-mobile-brand"><span className="brand-mark">W<span>!</span></span><strong>We Got Cha!</strong></div>
        <Suspense><LoginForm /></Suspense>
        <span className="login-copyright">© We Got Cha! · Internal operations</span>
      </div>
    </main>
  );
}
