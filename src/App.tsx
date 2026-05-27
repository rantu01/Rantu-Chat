import React, { useState, useEffect } from "react";
import { User } from "./types";
import Auth from "./components/Auth";
import Sidebar from "./components/Sidebar";
import Dashboard from "./components/Dashboard";
import { MessageSquare, Sparkles } from "lucide-react";

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  // Attempt to load session token from LocalStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem("whatsapp_gemini_token");
    if (savedToken) {
      setToken(savedToken);
      fetchUserProfile(savedToken);
    } else {
      setInitializing(false);
    }
  }, []);

  const fetchUserProfile = async (authToken: string) => {
    try {
      const resp = await fetch("/api/user/profile", {
        headers: {
          "Authorization": `Bearer ${authToken}`
        }
      });
      
      const contentType = resp.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("Session restore: Received non-JSON response from server (likely offline or restarting). Status:", resp.status);
        if (resp.status === 401 || resp.status === 403) {
          handleLogout();
        } else {
          setInitializing(false);
        }
        return;
      }

      const data = await resp.json();

      if (resp.ok && data.user) {
        setUser(data.user);
      } else {
        // Token has expired or is invalid, clear storage
        handleLogout();
      }
    } catch (err) {
      console.error("Session restore failed during startup:", err);
    } finally {
      setInitializing(false);
    }
  };

  const handleAuthSuccess = (newToken: string, userData: User) => {
    localStorage.setItem("whatsapp_gemini_token", newToken);
    setToken(newToken);
    setUser(userData);
  };

  const handleLogout = async () => {
    if (token) {
      // Best-effort logout trigger to notify backend
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`
          }
        });
      } catch (err) {
        console.error("Best-effort logout request failed:", err);
      }
    }

    localStorage.removeItem("whatsapp_gemini_token");
    setToken(null);
    setUser(null);
  };

  const handleSettingsUpdated = (updatedUser: User) => {
    setUser(updatedUser);
  };

  if (initializing) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#09090b] text-zinc-100 font-mono">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 mb-4 animate-pulse">
          <MessageSquare className="h-5 w-5" />
        </div>
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent mb-4" />
        <span className="text-[10px] text-zinc-500 tracking-wider uppercase font-bold">Initializing Agent Suite...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col font-sans selection:bg-zinc-800 selection:text-zinc-100">
      
      {!user || !token ? (
        <Auth onAuthSuccess={handleAuthSuccess} />
      ) : (
        <>
          {/* Top Integrated Nav Header */}
          <Sidebar 
            user={user} 
            onLogout={handleLogout} 
            onRefreshProfile={() => fetchUserProfile(token)} 
          />
          
          {/* Dashboard Panel View */}
          <main className="flex-1">
            <Dashboard 
              user={user} 
              token={token} 
              onRefreshUser={() => fetchUserProfile(token)}
              onSettingsUpdated={handleSettingsUpdated}
            />
          </main>
        </>
      )}

      {/* Global Brand Footer credit bar */}
      <footer className="shrink-0 border-t border-zinc-900 bg-zinc-950/20 py-5 text-center text-[9px] font-mono text-zinc-600 select-none uppercase tracking-wider">
        <div className="flex items-center justify-center gap-1.5">
          <Sparkles className="h-3 w-3 text-zinc-650" />
          <span>WhatsApp Gemini Responder Suite • All connections fully sandboxed.</span>
        </div>
      </footer>
    </div>
  );
}
