import React, { useState, useEffect } from "react";
import { QrCode, Wifi, WifiOff, RefreshCw, Terminal, Phone, CheckCircle2, ShieldAlert, BookOpen, ExternalLink, HelpCircle } from "lucide-react";
import { User, LogEntry, ChatMessage } from "../types";
import Settings from "./Settings";
import Simulator from "./Simulator";

interface DashboardProps {
  user: User;
  token: string;
  onRefreshUser: () => void;
  onSettingsUpdated: (updatedUser: any) => void;
}

export default function Dashboard({ user, token, onRefreshUser, onSettingsUpdated }: DashboardProps) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [chats, setChats] = useState<ChatMessage[]>([]);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLogs();
    fetchChats();
    
    // Auto-poll user status and logs/chats frequently when connecting to catch scans/updates
    const isConnecting = user.whatsappStatus === "Connecting" || user.whatsappStatus === "Loading QR Code";
    
    const interval = setInterval(() => {
      fetchLogs();
      fetchChats();
      if (isConnecting) {
        onRefreshUser();
      }
    }, isConnecting ? 2500 : 4000);

    return () => clearInterval(interval);
  }, [user.whatsappStatus]);

  // Sync QR URL from user object properties dynamically
  useEffect(() => {
    if (user.whatsappStatus === "Connecting" || user.whatsappStatus === "Loading QR Code") {
      if (user.qrUrl) {
        setQrUrl(user.qrUrl);
      }
    } else {
      setQrUrl(null);
    }
  }, [user.qrUrl, user.whatsappStatus]);

  const safeJson = async (res: Response) => {
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error(`Server currently offline or restarting (Status: ${res.status}).`);
    }
    return res.json();
  };

  const fetchLogs = async () => {
    try {
      const resp = await fetch("/api/user/logs", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (resp.status === 401 || resp.status === 403) {
        onRefreshUser();
        return;
      }
      const data = await safeJson(resp);
      if (resp.ok) {
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error("Failed to fetch logs", err);
    }
  };

  const fetchChats = async () => {
    try {
      const resp = await fetch("/api/user/chats", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (resp.status === 401 || resp.status === 403) {
        onRefreshUser();
        return;
      }
      const data = await safeJson(resp);
      if (resp.ok) {
        setChats(data.chats || []);
      }
    } catch (err) {
      console.error("Failed to fetch chats", err);
    }
  };

  // Launch connecting setup
  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const resp = await fetch("/api/whatsapp/connect", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await safeJson(resp);
      if (!resp.ok) throw new Error(data.error || "Failed to initiate pairing");
      
      setQrUrl(data.qrUrl);
      onRefreshUser();
      
      // Seed status loading wait states
      setTimeout(() => {
        onRefreshUser();
        fetchLogs();
      }, 2000);
    } catch (err: any) {
      setError(err.message || "Pairing initiation failed");
    } finally {
      setConnecting(false);
    }
  };

  // Terminate connection
  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      const resp = await fetch("/api/whatsapp/disconnect", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await safeJson(resp);
      if (!resp.ok) throw new Error(data.error || "Failed to disconnect session");

      setQrUrl(null);
      onRefreshUser();
      fetchLogs();
    } catch (err: any) {
      setError(err.message || "Termination failed");
    } finally {
      setDisconnecting(false);
    }
  };

  // Simulate scanning QR Code
  const handleSimulateScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setScanning(true);
    setError(null);
    try {
      const resp = await fetch("/api/whatsapp/simulate-scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          phoneNumber: phoneNumber ? phoneNumber : undefined
        })
      });
      const data = await safeJson(resp);
      if (!resp.ok) throw new Error(data.error || "Verification scan failed");

      setQrUrl(null);
      setPhoneNumber("");
      onRefreshUser();
      fetchLogs();
    } catch (err: any) {
      setError(err.message || "Scan validation failure");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      {/* Top Welcome Title */}
      <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-zinc-100 tracking-tight">
            Automation Dashboard
          </h2>
          <p className="text-zinc-455 text-xs mt-1">
            Manage your isolated WhatsApp automated responders using Google Gemini
          </p>
        </div>

        {/* Global connection notice banner */}
        <div className="flex items-center gap-2 rounded-full bg-zinc-900 border border-zinc-800 px-4 py-2">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
          </span>
          <span className="text-[10px] font-mono text-zinc-300 uppercase font-bold tracking-wider">
            Worker State: <span className="text-emerald-400">Online</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Connections + Configurations */}
        <div className="lg:col-span-7 space-y-8">
          
          {/* WhatsApp Connection Control Block */}
          <div 
            id="wa-connect-card"
            className="rounded-2xl border border-zinc-805 bg-zinc-900/40 p-6"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-6">
              <div className="flex items-center gap-2.5">
                <QrCode className="h-4.5 w-4.5 text-zinc-400" />
                <h3 className="text-sm font-bold text-zinc-100">
                  Link Your Device
                </h3>
              </div>

              {/* Status pill element */}
              <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-950 border border-zinc-900 rounded-lg">
                <div className={`h-1.5 w-1.5 rounded-full ${
                  user.whatsappStatus === "Authenticated"
                    ? "bg-emerald-500"
                    : user.whatsappStatus === "Connecting" || user.whatsappStatus === "Loading QR Code"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-red-400"
                }`} />
                <span className="text-[9px] font-mono font-bold uppercase text-zinc-400 tracking-widest">{user.whatsappStatus}</span>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2.5 rounded-xl border border-red-500/15 bg-red-500/5 px-4 py-3 text-xs text-red-400 mb-6">
                <ShieldAlert className="h-4 w-4 text-red-500 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Connection View Layouts */}
            {user.whatsappStatus === "Disconnected" && (
              <div className="text-center py-8">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-950 border border-zinc-850 text-zinc-500">
                  <WifiOff className="h-5 w-5" />
                </div>
                <h4 className="text-xs font-bold text-zinc-200 mb-2 uppercase tracking-widest">Service Offline</h4>
                <p className="text-xs text-zinc-500 max-w-md mx-auto leading-relaxed mb-6 font-mono">
                  No active session pairing has been established. Click the connection trigger below to generate a linkage QR Code.
                </p>
                <button
                  id="connect-wa-btn"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="rounded-xl bg-zinc-100 hover:bg-zinc-250 text-zinc-950 font-bold text-xs px-5 py-2.5 cursor-pointer transition flex items-center gap-2 mx-auto disabled:opacity-50"
                >
                  {connecting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                  <span>{connecting ? "Initializing Server Instance..." : "Connect WhatsApp (Generate QR)"}</span>
                </button>
              </div>
            )}

            {(user.whatsappStatus === "Connecting" || user.whatsappStatus === "Loading QR Code") && (
              <div className="flex flex-col md:flex-row gap-6 items-center p-5 bg-zinc-950/60 border border-zinc-850 rounded-xl">
                {/* QR Display container */}
                <div className="bg-white p-3 rounded-xl shrink-0 border border-zinc-800 shadow-md">
                  {qrUrl ? (
                    <img id="qr-code-img" src={qrUrl} alt="WhatsApp Link QR Code" className="w-36 h-36" />
                  ) : (
                    <div className="w-36 h-36 flex flex-col items-center justify-center gap-2 text-zinc-700 bg-zinc-50 rounded-lg">
                      <RefreshCw className="h-4 w-4 animate-spin text-zinc-950" />
                      <span className="text-[9px] font-mono font-bold uppercase tracking-wider">Acquiring QR...</span>
                    </div>
                  )}
                </div>

                <div className="flex-1 space-y-4 text-center md:text-left">
                  <div>
                    <h4 className="text-[10px] font-bold text-zinc-200 uppercase tracking-widest mb-1.5 flex items-center justify-center md:justify-start gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-ping" />
                      <span>Ready to Synchronize</span>
                    </h4>
                    <p className="text-[11px] leading-relaxed text-zinc-400 font-mono">
                      Because public datacenter IPs may trigger instant bans from WhatsApp systems, scan this QR with your simulator device, or directly input your test number below to <span className="text-zinc-200 font-bold">Simulate Scanning</span> safely and instantly!
                    </p>
                  </div>

                  <form onSubmit={handleSimulateScan} className="flex gap-2">
                    <div className="flex-1 min-w-0">
                      <input
                        id="phone-scan-input"
                        type="text"
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-700 outline-none focus:border-zinc-700"
                        placeholder="Device number (e.g. +15557818051)"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                      />
                    </div>
                    <button
                      id="submit-scan-btn"
                      type="submit"
                      disabled={scanning}
                      className="rounded-lg bg-zinc-100 hover:bg-zinc-200 px-4 py-2 text-xs font-bold text-zinc-950 shrink-0 cursor-pointer disabled:opacity-40"
                    >
                      {scanning ? "Linking..." : "Simulate Scan"}
                    </button>
                  </form>

                  <button
                    id="cancel-connect-btn"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    className="text-[10px] font-mono font-bold text-red-400 hover:text-red-300 transition cursor-pointer disabled:opacity-55 block mx-auto md:mx-0"
                  >
                    Cancel Connection Session
                  </button>
                </div>
              </div>
            )}

            {user.whatsappStatus === "Authenticated" && (
              <div className="flex flex-col sm:flex-row items-center gap-6 p-5 bg-zinc-950/60 border border-zinc-850 rounded-xl">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                
                <div className="flex-1 text-center sm:text-left">
                  <div className="flex items-center justify-center sm:justify-start gap-2 mb-1.5">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-200">Session Linked Successfully</h4>
                    <span className="rounded bg-emerald-550/10 border border-emerald-550/20 px-1.5 py-0.5 text-[8px] font-bold text-emerald-400 uppercase font-mono tracking-widest leading-none">ACTIVE</span>
                  </div>
                  <p className="text-xs text-zinc-450 font-mono leading-relaxed mb-4">
                    Linked to WhatsApp: <span className="text-zinc-300 font-bold">{user.whatsappNumber || "Simulation Sandbox Mode"}</span>
                  </p>
                  
                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-3">
                    <button
                      id="disconnect-wa-btn"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="rounded-lg border border-red-500/30 bg-red-500/5 hover:bg-red-500/10 px-3 py-1.5 text-[10px] font-mono font-bold text-red-400 cursor-pointer disabled:opacity-40 transition-colors"
                    >
                      {disconnecting ? "Terminating..." : "Disconnect Session"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* AI Settings Block */}
          <Settings user={user} onSettingsUpdated={onSettingsUpdated} token={token} />

        </div>

        {/* Right Column: Simulator & Live Event Terminal Console */}
        <div className="lg:col-span-5 space-y-8 flex flex-col">
          
          {/* WhatsApp Interactive Simulator */}
          <div className="flex-1">
            <Simulator 
              user={user} 
              token={token} 
              chats={chats} 
              onChatsUpdated={fetchChats}
              onRefreshLogs={fetchLogs}
            />
          </div>

          {/* Live Monitor Event Console Console Screen */}
          <div 
            id="logs-card"
            className="rounded-2xl border border-zinc-805 bg-zinc-900/40 p-6 flex flex-col"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4 shrink-0">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-zinc-400" />
                <h4 className="text-[10px] font-bold text-zinc-200 uppercase tracking-widest font-mono">
                  Recent Automation Log
                </h4>
              </div>

              {/* Refresh Event Logs Manual Trigger */}
              <button
                id="refresh-logs-btn"
                title="Refresh Console Logs"
                onClick={fetchLogs}
                className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-500 hover:text-zinc-200 transition cursor-pointer"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>

            {/* Console view layout screen */}
            <div 
              id="console-screen"
              className="flex-1 overflow-y-auto max-h-[220px] min-h-[140px] space-y-2.5 font-mono text-[9px] bg-[#09090b] p-3 border border-zinc-900 rounded-xl h-full"
            >
              {logs.length === 0 ? (
                <div className="text-center text-zinc-600 py-10">No activities reported yet.</div>
              ) : (
                logs.map((log) => {
                  let badgeColor = "text-zinc-500";
                  if (log.type === "success") badgeColor = "text-zinc-300";
                  if (log.type === "warning") badgeColor = "text-amber-400";
                  if (log.type === "error") badgeColor = "text-red-400";
                  if (log.type === "ai") badgeColor = "text-emerald-400";

                  return (
                    <div key={log.id} className="flex items-start gap-2 border-b border-zinc-905 pb-2 leading-relaxed">
                      {/* Timestamp panel prefix */}
                      <span className="text-zinc-600 select-none shrink-0 font-light">
                        [{new Date(log.timestamp).toLocaleTimeString()}]
                      </span>
                      
                      {/* Categorization tag label */}
                      <span className={`font-bold uppercase tracking-wider shrink-0 mr-1 ${badgeColor}`}>
                        {log.type === "ai" ? "🤖 [gemini]" : `[${log.type}]`}
                      </span>

                      {/* Log body contents */}
                      <span className="text-zinc-400 select-text">{log.message}</span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Quick documentation guidance footer info */}
            <div className="mt-4 shrink-0 rounded-xl bg-zinc-950/60 border border-zinc-900 px-4 py-3 text-[9px] font-mono leading-relaxed text-zinc-500 flex items-start gap-1.5">
              <BookOpen className="h-3.5 w-3.5 text-zinc-455 shrink-0 mt-0.5" />
              <div>
                <span className="text-zinc-400 font-bold block mb-0.5">Deployment Guideline</span>
                For production integration scanning with official phones, configure your deployment with a persistent database URI string inside <span className="text-zinc-300">/src/server/whatsapp-engine.ts</span>.
              </div>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
