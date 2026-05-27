import React, { useState } from "react";
import { LogIn, UserPlus, ShieldAlert, Sparkles, MessageSquare } from "lucide-react";

interface AuthProps {
  onAuthSuccess: (token: string, userData: any) => void;
}

export default function Auth({ onAuthSuccess }: AuthProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const endpoint = isLogin ? "/api/auth/login" : "/api/auth/signup";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const fallbackText = await response.text();
        throw new Error(fallbackText || `Server returned a non-JSON response (status ${response.status}).`);
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Something went wrong. Please check your inputs.");
      }

      onAuthSuccess(data.token, data.user);
    } catch (err: any) {
      setError(err.message || "Network connection failure");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[92vh] items-center justify-center p-4">
      <div 
        id="auth-container"
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-zinc-800 bg-[#09090b] shadow-[0_0_50px_rgba(0,0,0,0.5)] transition-all duration-300"
      >
        <div className="p-8">
          {/* Logo and Greeting Header */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <MessageSquare className="h-5.5 w-5.5" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-100 mb-2">
              Gemini Responder
            </h1>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {isLogin 
                ? "Sign in to manage your automated WhatsApp AI reply agent" 
                : "Create your secure account to initialize your personal AI agent"}
            </p>
          </div>

          {/* Form container */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div 
                id="auth-error-banner"
                className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-400"
              >
                <ShieldAlert className="h-4 w-4 shrink-0 text-red-500" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="block text-[10px] font-bold tracking-wider text-zinc-400 uppercase mb-2">
                Email Address
              </label>
              <input
                id="auth-email-input"
                type="email"
                required
                className="w-full rounded-xl border border-zinc-850 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-700 outline-none transition-all focus:border-zinc-700 focus:ring-1 focus:ring-zinc-800"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold tracking-wider text-zinc-400 uppercase mb-2">
                Security Password
              </label>
              <input
                id="auth-password-input"
                type="password"
                required
                minLength={6}
                className="w-full rounded-xl border border-zinc-850 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-700 outline-none transition-all focus:border-zinc-700 focus:ring-1 focus:ring-zinc-800"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button
              id="auth-submit-btn"
              type="submit"
              disabled={loading}
              className="relative w-full overflow-hidden rounded-xl bg-zinc-100 hover:bg-zinc-200 p-3 text-xs font-bold text-zinc-950 transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer"
            >
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-950 border-t-transparent" />
                  <span>Processing...</span>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2">
                  {isLogin ? <LogIn className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                  <span>{isLogin ? "Sign In to Agent" : "Create Account & Start"}</span>
                </div>
              )}
            </button>
          </form>

          {/* Toggle button */}
          <div className="mt-6 text-center pt-5 border-t border-zinc-900">
            <button
              id="auth-toggle-mode-btn"
              onClick={() => {
                setIsLogin(!isLogin);
                setError(null);
              }}
              className="group text-xs text-zinc-500 hover:text-zinc-300 transition-all cursor-pointer"
            >
              {isLogin ? (
                <span>
                  Don't have an account?{" "}
                  <span className="font-semibold text-emerald-400 group-hover:underline">Create profile</span>
                </span>
              ) : (
                <span>
                  Already have an agent account?{" "}
                  <span className="font-semibold text-emerald-400 group-hover:underline">Sign in</span>
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Brand note */}
        <div className="flex items-center justify-center gap-1.5 bg-zinc-950 px-8 py-3.5 border-t border-zinc-900 text-[10px] font-mono text-zinc-500">
          <Sparkles className="h-3 w-3 text-emerald-500" />
          <span>Equipped with Gemini 3.5 & WhatsApp Baileys Routing</span>
        </div>
      </div>
    </div>
  );
}
