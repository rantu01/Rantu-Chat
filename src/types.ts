export interface User {
  id: string;
  email: string;
  geminiApiKey: string;
  botName: string;
  systemInstruction: string;
  whatsappStatus: "Disconnected" | "Loading QR Code" | "Connecting" | "Authenticated";
  whatsappNumber?: string;
  qrUrl?: string;
  isPaused: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  sender: string; // "user" or "bot" (replier) or "+1555XXXXX" (incoming simulates)
  text: string;
  timestamp: string;
  isSimulated?: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  type: "info" | "success" | "warning" | "error" | "ai";
  message: string;
}

export interface SessionData {
  user: {
    id: string;
    email: string;
  } | null;
  token: string | null;
}
