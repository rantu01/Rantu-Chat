import { LogOut, Bot, Sparkles, Wifi, WifiOff, RefreshCw } from "lucide-react";
import { User } from "../types";

interface SidebarProps {
  user: User;
  onLogout: () => void;
  onRefreshProfile: () => void;
}

export default function Sidebar({ user, onLogout, onRefreshProfile }: SidebarProps) {
  return (
    <header 
      id="app-header"
      className="sticky top-0 z-50 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md px-6 py-4"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between">
        {/* Brand/App Title Logo */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-950 shadow-sm">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold tracking-tight text-zinc-105 leading-none">
                WA-Gemini Agent
              </h2>
              <span className="rounded-full bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-[8px] font-bold font-mono text-zinc-400 uppercase tracking-wider">
                Multi-User Room
              </span>
            </div>
            <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
              Profile: <span className="text-zinc-350 font-medium">{user.email}</span>
            </p>
          </div>
        </div>

        {/* Global Connection & Actions Row */}
        <div className="flex items-center gap-3">
          {/* Status Indicator Badge */}
          <div 
            id="global-status-badge"
            className={`hidden sm:flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-mono font-bold uppercase transition-all duration-300 ${
              user.whatsappStatus === "Authenticated"
                ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-400"
                : user.whatsappStatus === "Connecting" || user.whatsappStatus === "Loading QR Code"
                ? "bg-amber-500/10 border-amber-500/25 text-amber-400 animate-pulse"
                : "bg-zinc-900 border-zinc-800 text-zinc-500"
            }`}
          >
            {user.whatsappStatus === "Authenticated" ? (
              <>
                <Wifi className="h-3 w-3" />
                <span>ONLINE ({user.whatsappNumber || "Simulation"})</span>
              </>
            ) : (
              <>
                <WifiOff className="h-3 w-3" />
                <span>STATUS: {user.whatsappStatus}</span>
              </>
            )}
          </div>

          {/* Sync Trigger Button */}
          <button
            id="refresh-profile-btn"
            title="Refresh System Configuration"
            onClick={onRefreshProfile}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-white transition cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>

          {/* Sign Out Button */}
          <button
            id="log-out-btn"
            onClick={onLogout}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:text-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-400 transition cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
