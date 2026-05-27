import React, { useState, useEffect, useRef } from "react";
import { Send, Smartphone, Shield, Sparkles, MessageSquare, Trash2, Clock, CheckCheck } from "lucide-react";
import { ChatMessage, User } from "../types";

interface SimulatorProps {
  user: User;
  token: string;
  chats: ChatMessage[];
  onChatsUpdated: () => void;
  onRefreshLogs: () => void;
}

const TEST_IDENTITIES = [
  { name: "+1 (555) 781-8051", label: "Sarah (New Customer)", avatar: "👩‍💼" },
  { name: "+1 (555) 234-9642", label: "Alex (General Inquiry)", avatar: "🧑‍💻" },
  { name: "+44 7911 123456", label: "Global Lead (Urgent)", avatar: "🌐" }
];

export default function Simulator({ user, token, chats, onChatsUpdated, onRefreshLogs }: SimulatorProps) {
  const [selectedSender, setSelectedSender] = useState(TEST_IDENTITIES[0]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Auto-scrolling to bottom has been disabled per user request
  /*
  useEffect(() => {
    scrollToBottom();
  }, [chats]);
  */

  const scrollToBottom = () => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || sending) return;

    const messageToSend = inputText.trim();
    setInputText("");
    setSending(true);
    setTyping(true);

    try {
      // POST to our server simulation route
      const response = await fetch("/api/simulator/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          fromName: selectedSender.name,
          messageText: messageToSend
        })
      });

      if (!response.ok) {
        throw new Error("Generation failure inside simulation module");
      }

      // Successfully processed! Update chats view and log pane
      onChatsUpdated();
      onRefreshLogs();
    } catch (err) {
      console.error("Simulator transmit error:", err);
    } finally {
      setSending(false);
      setTyping(false);
    }
  };

  const handleClearHistory = async () => {
    if (window.confirm("Are you sure you want to clear simulated chat message history?")) {
      try {
        await fetch("/api/user/chats/clear", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`
          }
        });
        onChatsUpdated();
        onRefreshLogs();
      } catch (err) {
        console.error("Clear messages error:", err);
      }
    }
  };

  return (
    <div 
      id="simulator-wrapper"
      className="flex flex-col h-full rounded-2xl border border-zinc-800 bg-[#09090b] overflow-hidden shadow-sm"
    >
      {/* Phone Header */}
      <div className="flex items-center justify-between border-b border-zinc-900 bg-zinc-900/30 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900 border border-zinc-805 text-zinc-400">
            <Smartphone className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h4 className="text-xs font-bold text-zinc-200">
                WhatsApp Live Sandbox
              </h4>
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>
            <p className="text-[9px] font-mono text-zinc-500">
              Interactive testing simulator
            </p>
          </div>
        </div>

        {/* Clear History Button */}
        <button
          id="clear-chats-btn"
          title="Clear Chat Logs"
          onClick={handleClearHistory}
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 border border-zinc-850 text-zinc-500 hover:text-red-400 hover:border-red-955 transition cursor-pointer"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Identity Selector */}
      <div className="border-b border-zinc-900 bg-zinc-905/30 px-5 py-3">
        <label className="block text-[9px] font-bold font-mono text-zinc-500 uppercase tracking-widest mb-1.5">
          Select Sender Persona:
        </label>
        <div className="flex flex-wrap gap-2">
          {TEST_IDENTITIES.map((identity) => (
            <button
              id={`identity-btn-${identity.name.replace(/\D/g, '')}`}
              key={identity.name}
              onClick={() => setSelectedSender(identity)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-mono font-medium border transition cursor-pointer ${
                selectedSender.name === identity.name
                  ? "bg-zinc-100 border-zinc-200 text-zinc-950"
                  : "bg-zinc-900/80 border-zinc-800 text-zinc-400 hover:text-white"
              }`}
            >
              <span>{identity.avatar}</span>
              <span>{identity.label.split(" ")[0]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Screen View */}
      <div 
        id="phone-screen"
        className="flex-1 overflow-y-auto px-5 py-6 space-y-4 max-h-[420px] min-h-[350px]"
      >
        {chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 bg-zinc-900/30 rounded-xl border border-zinc-900">
            <MessageSquare className="h-7 w-7 text-zinc-650 mb-2.5" />
            <h5 className="text-[11px] font-bold text-zinc-400">No Chat History</h5>
            <p className="text-[10px] text-zinc-650 max-w-xs mt-1 leading-relaxed">
              Formulate a question in the input panel below to simulate a message arriving on WhatsApp.
            </p>
          </div>
        ) : (
          chats.map((chat) => {
            const isBot = chat.sender === "bot";
            return (
              <div
                key={chat.id}
                className={`flex flex-col ${isBot ? "items-start" : "items-end"}`}
              >
                {/* Sender Tag */}
                <div className="text-[9px] font-mono text-zinc-500 mb-1 px-1">
                  {isBot ? `🤖 ${user.botName} (AI)` : `💬 ${chat.sender}`}
                </div>

                {/* Message Bubble */}
                <div
                  className={`rounded-xl max-w-[85%] px-3.5 py-2 text-xs leading-relaxed ${
                    isBot
                      ? "bg-zinc-900 border border-zinc-805 text-zinc-200 rounded-tl-none"
                      : "bg-zinc-100 text-zinc-950 rounded-tr-none"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{chat.text}</p>
                  
                  {/* Footer Timestamp */}
                  <div className="flex items-center justify-end gap-1 text-[8px] font-mono opacity-50 mt-2">
                    <Clock className="h-2 w-2" />
                    <span>{new Date(chat.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {!isBot && <CheckCheck className="h-3 w-3 text-emerald-600" />}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Animated typing indicator */}
        {typing && (
          <div className="flex flex-col items-start">
            <div className="text-[9px] font-mono text-zinc-500 mb-1 px-1">
               🤖 {user.botName} is processing
            </div>
            <div className="rounded-xl bg-zinc-900/60 border border-zinc-850 px-3.5 py-2 flex items-center gap-1 shadow-md">
              <span className="flex h-1 w-1 rounded-full bg-emerald-500 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="flex h-1 w-1 rounded-full bg-emerald-500 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="flex h-1 w-1 rounded-full bg-emerald-500 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        )}

        <div ref={chatBottomRef} />
      </div>

      {/* Input panel Form */}
      <form 
        onSubmit={handleSendMessage}
        className="p-4 border-t border-zinc-900 bg-zinc-900/30"
      >
        <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-850 rounded-xl p-1.5 focus-within:border-zinc-800 transition-all">
          {/* Avatar prefix indicator */}
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 font-mono text-xs shrink-0 text-zinc-400">
            {selectedSender.avatar}
          </div>

          <input
            id="simulator-message-input"
            type="text"
            required
            disabled={sending}
            placeholder={`Message as ${selectedSender.name.split(" ")[0]}...`}
            className="flex-1 bg-transparent px-2 text-xs text-zinc-100 placeholder-zinc-700 outline-none"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />

          <button
            id="simulator-send-btn"
            type="submit"
            disabled={sending || !inputText.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 text-zinc-950 hover:bg-zinc-200 transition-all shrink-0 cursor-pointer"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>

        {/* Security Warning notice */}
        <div className="flex items-center gap-1.5 justify-center mt-3 text-[9px] font-mono text-zinc-600">
          <Shield className="h-2.5 w-2.5 text-zinc-500" />
          <span>Real-time Gemini responder engine testing simulation</span>
        </div>
      </form>
    </div>
  );
}
