import React, { useState, useEffect } from "react";
import { Save, HelpCircle, ToggleLeft, ToggleRight, Sparkles, Key, FileText, Bot } from "lucide-react";
import { User } from "../types";

interface SettingsProps {
  user: User;
  onSettingsUpdated: (updatedUser: any) => void;
  token: string;
}

export default function Settings({ user, onSettingsUpdated, token }: SettingsProps) {
  const [apiKey, setApiKey] = useState("");
  const [botName, setBotName] = useState(user.botName);
  const [systemInstruction, setSystemInstruction] = useState(user.systemInstruction);
  const [isPaused, setIsPaused] = useState(user.isPaused);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    setBotName(user.botName);
    setSystemInstruction(user.systemInstruction);
    setIsPaused(user.isPaused);
  }, [user]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/user/update-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          geminiApiKey: apiKey ? apiKey : undefined, // only send if overridden
          botName,
          systemInstruction,
          isPaused
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to save settings");
      }

      onSettingsUpdated(data.user);
      setMessage({ text: "AI Configuration updated successfully!", type: "success" });
      setApiKey(""); // clear password-like input
    } catch (err: any) {
      setMessage({ text: err.message || "Network error while saving.", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePause = async () => {
    const nextPaused = !isPaused;
    setIsPaused(nextPaused);

    try {
      const response = await fetch("/api/user/update-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ isPaused: nextPaused })
      });

      const data = await response.json();
      if (response.ok) {
        onSettingsUpdated(data.user);
      }
    } catch (err) {
      console.error("Failed to toggle pause", err);
    }
  };

  return (
    <div 
      id="settings-card"
      className="rounded-2xl border border-zinc-805 bg-zinc-900/40 p-6"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-6">
        <div className="flex items-center gap-2.5">
          <Sparkles className="h-4.5 w-4.5 text-zinc-400" />
          <h3 className="text-sm font-bold text-zinc-100">
            Gemini Configuration
          </h3>
        </div>

        {/* Play/Pause Button */}
        <button
          id="toggle-paused-btn"
          type="button"
          onClick={handleTogglePause}
          className={`flex items-center gap-2 rounded-lg px-3 py-1 text-[10px] font-mono font-bold border transition cursor-pointer ${
            isPaused
              ? "bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20"
              : "bg-emerald-500/10 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20"
          }`}
        >
          {isPaused ? (
            <>
              <ToggleLeft className="h-3.5 w-3.5" />
              <span>PAUSED MODE</span>
            </>
          ) : (
            <>
              <ToggleRight className="h-3.5 w-3.5" />
              <span>ACTIVE RESPONDING</span>
            </>
          )}
        </button>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {message && (
          <div 
            id="settings-feedback-banner"
            className={`rounded-xl border px-4 py-3 text-xs font-medium font-mono ${
              message.type === "success"
                ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-400"
                : "bg-red-500/10 border-red-500/25 text-red-400"
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Bot Identity Label */}
        <div>
          <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-450 mb-2">
            <Bot className="h-3.5 w-3.5 text-zinc-500" />
            <span>Agent Bot Name</span>
          </label>
          <input
            id="settings-bot-name-input"
            type="text"
            required
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-700 outline-none focus:border-zinc-700 transition-all font-mono"
            placeholder="e.g. Gemini Assistant Bot"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
          />
          <p className="text-[10px] text-zinc-500 mt-1.5 font-mono leading-relaxed">
            The bot identifies itself with this name in conversational messages.
          </p>
        </div>

        {/* API Key Override Setting */}
        <div>
          <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-450 mb-2">
            <Key className="h-3.5 w-3.5 text-zinc-500" />
            <span>Custom Gemini API Key Override</span>
          </label>
          <input
            id="settings-api-key-input"
            type="password"
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-700 outline-none focus:border-zinc-700 transition-all font-mono"
            placeholder={user.geminiApiKey ? "•••••••••••••••• (Key Configured)" : "Paste key (Leave blank to use system default key)"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div className="mt-2 rounded-lg bg-zinc-950/60 border border-zinc-900 px-3.5 py-2 text-[10px] font-mono text-zinc-500 leading-relaxed">
            <span className="text-zinc-450 font-bold">💡 Pro-Tip:</span> If you don't have an override key, leave this blank! We automatically route requests through your workspace's secure environment key securely server-side.
          </div>
        </div>

        {/* System Instructions Setting */}
        <div>
          <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-450 mb-2">
            <FileText className="h-3.5 w-3.5 text-zinc-500" />
            <span>Agent System Instructions</span>
          </label>
          <textarea
            id="settings-instructions-input"
            rows={4}
            required
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-100 placeholder-zinc-700 outline-none focus:border-zinc-700 transition-all font-mono leading-relaxed resize-none"
            placeholder="Introduce system specifications, rules, constraints..."
            value={systemInstruction}
            onChange={(e) => setSystemInstruction(e.target.value)}
          />
          <p className="text-[10px] text-zinc-500 mt-1.5 font-mono leading-relaxed">
            These instructions act as custom system constraints sent to Gemini, defining the personality, boundaries, and logic of automatic replies.
          </p>
        </div>

        <button
          id="settings-save-btn"
          type="submit"
          disabled={saving}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 px-4 py-3 text-xs font-bold text-zinc-950 shadow-sm active:scale-[0.98] disabled:opacity-50 cursor-pointer transition-all"
        >
          {saving ? (
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-950 border-t-transparent" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          <span>{saving ? "Updating Systems..." : "Save AI Configuration"}</span>
        </button>
      </form>

      <div className="mt-6 pt-5 border-t border-zinc-800 flex items-center gap-2 text-[10px] font-mono text-zinc-500">
        <HelpCircle className="h-3.5 w-3.5 text-zinc-600" />
        <span>Get a secure key on <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer" className="text-zinc-400 underline hover:text-zinc-350">Google AI Studio</a></span>
      </div>
    </div>
  );
}
