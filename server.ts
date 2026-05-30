import express, { Request, Response, NextFunction } from "express";
import { createServer as createHttpServer } from "http";
import net from "net";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { db, hashPassword, initializeDatabase, createMongoAuthState, clearMongoAuthState } from "./src/server/db.ts";

dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT?.trim() || 3000);

app.use(express.json());

// Active WhatsApp Web sockets tracking
const activeSockets = new Map<string, any>(); // User ID -> WASocket
const userCurrentQrs = new Map<string, string>(); // User ID -> Last raw QR string
const activePairingSessions = new Set<string>(); // User ID -> Pairing flow currently in progress
type PendingAutoReply = {
  timeoutId: ReturnType<typeof setTimeout>;
  version: number;
  receivedAt: number;
  seenCancelWindowSeconds: number;
  senderLabel: string;
};

const pendingAutoReplies = new Map<string, Map<string, PendingAutoReply>>();

function normalizeDelaySeconds(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return 2;
  }

  return Math.max(2, Math.floor(numericValue));
}

function normalizeSeenCancelSeconds(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.floor(numericValue));
}

function normalizePhoneNumberForPairing(input: unknown) {
  const raw = typeof input === "string" ? input.trim() : "";
  const digits = raw.replace(/\D/g, "");

  if (digits.length < 10 || digits.length > 15 || digits.startsWith("0")) {
    return null;
  }

  return {
    digits,
    displayNumber: `+${digits}`
  };
}

async function forceCloseUserSocket(userId: string) {
  if (!activeSockets.has(userId)) {
    return;
  }

  try {
    const sock = activeSockets.get(userId);
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("messages.upsert");
    await sock.end(undefined);
  } catch {
    // Best effort cleanup only
  } finally {
    activeSockets.delete(userId);
  }
}

async function resetWhatsAppSession(userId: string, nextStatus: "Disconnected" | "Connecting" = "Disconnected") {
  await forceCloseUserSocket(userId);
  userCurrentQrs.delete(userId);
  pendingAutoReplies.delete(userId);
  activePairingSessions.delete(userId);
  await clearMongoAuthState(userId);
  await db.updateUser(userId, {
    whatsappStatus: nextStatus,
    whatsappNumber: undefined
  });
}

async function waitForSocketReady(userId: string, timeoutMs = 12000): Promise<any | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const sock = activeSockets.get(userId);
    if (sock && typeof sock.requestPairingCode === "function") {
      return sock;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

async function requestPhonePairingCode(userId: string, phoneDigits: string): Promise<string> {
  const sock = await waitForSocketReady(userId);
  if (!sock) {
    throw new Error("WhatsApp session is still initializing. Please try again in a few seconds.");
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const pairingCode = await sock.requestPairingCode(phoneDigits);
      if (pairingCode) {
        return pairingCode;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  throw new Error(
    lastError instanceof Error
      ? `Unable to generate pairing code right now: ${lastError.message}`
      : "Unable to generate pairing code right now."
  );
}

function getConversationKey(remoteJid: string | undefined, fallback: string) {
  return remoteJid || fallback;
}

function clearPendingAutoReply(userId: string, conversationKey: string) {
  const userPendingReplies = pendingAutoReplies.get(userId);
  if (!userPendingReplies) {
    return;
  }

  const pending = userPendingReplies.get(conversationKey);
  if (pending) {
    clearTimeout(pending.timeoutId);
    userPendingReplies.delete(conversationKey);
  }

  if (userPendingReplies.size === 0) {
    pendingAutoReplies.delete(userId);
  }
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user?.isAdmin) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }

  next();
}

function scheduleAutoReply(options: {
  userId: string;
  conversationKey: string;
  senderLabel: string;
  messageText: string;
  isSimulated: boolean;
  delaySeconds: number;
  seenCancelWindowSeconds: number;
  receivedAt?: number;
  sock?: any;
  remoteJid?: string;
}) {
  const { userId, conversationKey, senderLabel, messageText, isSimulated, delaySeconds, seenCancelWindowSeconds, receivedAt, sock, remoteJid } = options;

  clearPendingAutoReply(userId, conversationKey);

  const userPendingReplies = pendingAutoReplies.get(userId) || new Map<string, PendingAutoReply>();
  const version = (userPendingReplies.get(conversationKey)?.version || 0) + 1;
  const startedAt = receivedAt || Date.now();
  const timeoutId = setTimeout(async () => {
    const currentPending = pendingAutoReplies.get(userId)?.get(conversationKey);
    if (!currentPending || currentPending.version !== version) {
      return;
    }

    clearPendingAutoReply(userId, conversationKey);

    try {
      const userProfile = await db.getUserById(userId);
      if (!userProfile || userProfile.isPaused) {
        return;
      }

      await db.addLog(userId, "ai", `Generating delayed auto-reply for ${senderLabel}...`);
      const aiReply = await generateGeminiResponseForUser(userProfile, senderLabel, messageText);

      if (isSimulated) {
        await db.addChat(userId, {
          sender: "bot",
          text: aiReply,
          isSimulated: true
        });
      } else if (sock && remoteJid) {
        await sock.sendMessage(remoteJid, { text: aiReply });
        await db.addChat(userId, {
          sender: "bot",
          text: aiReply,
          isSimulated: false
        });
      }

      await db.incrementAiReplyCount(userId);

      await db.addLog(userId, "success", `Auto-replied to ${senderLabel} after a delay.`);
    } catch (error: any) {
      console.error(`Delayed auto-reply failed for user ${userId}:`, error);
      await db.addLog(userId, "error", `Delayed auto-reply failed: ${error.message || error.toString()}`);
    }
  }, normalizeDelaySeconds(delaySeconds) * 1000);

  userPendingReplies.set(conversationKey, {
    timeoutId,
    version,
    receivedAt: startedAt,
    seenCancelWindowSeconds: normalizeSeenCancelSeconds(seenCancelWindowSeconds),
    senderLabel
  });
  pendingAutoReplies.set(userId, userPendingReplies);
}

async function findAvailablePort(startPort: number, maxAttempts = 20): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidatePort = startPort + offset;

    const isAvailable = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();

      probe.once("error", () => {
        resolve(false);
      });

      probe.once("listening", () => {
        probe.close(() => resolve(true));
      });

      probe.listen(candidatePort, "0.0.0.0");
    });

    if (isAvailable) {
      return candidatePort;
    }
  }

  throw new Error(`Unable to find a free port starting at ${startPort}.`);
}

// Custom Authentication Middleware
async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    res.status(401).json({ error: "Access denied. Authentication token is missing." });
    return;
  }

  const userId = verifySessionToken(token);
  if (!userId) {
    res.status(403).json({ error: "Session expired or invalid. Please log in again." });
    return;
  }

  const user = await db.getUserById(userId);
  if (!user) {
    res.status(404).json({ error: "User profile not found." });
    return;
  }

  await db.touchUserActivity(userId);

  // Bind user to request context
  (req as any).user = user;
  (req as any).token = token;
  next();
}

function createSessionToken(userId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, issuedAt: Date.now() })).toString("base64url");
  const secret = process.env.SESSION_SECRET?.trim() || process.env.GEMINI_API_KEY?.trim() || "whatsapp-gemini-auto-responder-session-secret";
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(token: string) {
  const [payload, signature] = token.split(".");

  if (!payload || !signature) {
    return null;
  }

  const secret = process.env.SESSION_SECRET?.trim() || process.env.GEMINI_API_KEY?.trim() || "whatsapp-gemini-auto-responder-session-secret";
  const expectedSignature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { userId?: string };
    return decoded.userId || null;
  } catch {
    return null;
  }
}

// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================

// Register a new user
app.post("/api/auth/signup", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are both required." });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters long." });
      return;
    }

    // Check if user already exists
    const existing = await db.getUserByEmail(email);
    if (existing) {
      res.status(422).json({ error: "An account with this email already exists." });
      return;
    }

    const hashedPassword = hashPassword(password);
    const user = await db.createUser(email, hashedPassword);

    // Automatically generate session token upon registration
    const sessionToken = createSessionToken(user.id);

    // Securely return user info (omit credentials)
    res.status(201).json({
      message: "Account registered successfully",
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        botName: user.botName,
        systemInstruction: user.systemInstruction,
        whatsappStatus: user.whatsappStatus,
        isPaused: user.isPaused,
        isAdmin: user.isAdmin,
        autoReplyDelaySeconds: user.autoReplyDelaySeconds,
        lastActiveAt: user.lastActiveAt
      }
    });
  } catch (error: any) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Internal server error during account registration." });
  }
});

// Login user
app.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are both required." });
      return;
    }

    const hashedPassword = hashPassword(password);
    const user = await db.verifyAndGetUser(email, hashedPassword);

    if (!user) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    // Generate login token
    const sessionToken = createSessionToken(user.id);

    await db.addLog(user.id, "info", `Logged in from IP ${req.ip || "unknown"}`);

    res.json({
      message: "Login successful",
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        botName: user.botName,
        systemInstruction: user.systemInstruction,
        whatsappStatus: user.whatsappStatus,
        isPaused: user.isPaused,
        isAdmin: user.isAdmin,
        autoReplyDelaySeconds: user.autoReplyDelaySeconds,
        lastActiveAt: user.lastActiveAt,
        geminiApiKey: user.geminiApiKey ? `${user.geminiApiKey.substring(0, 5)}...${user.geminiApiKey.substring(user.geminiApiKey.length - 4)}` : ""
      }
    });
  } catch (error: any) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error during authentication." });
  }
});

// Logout user
app.post("/api/auth/logout", authenticateToken, async (req: Request, res: Response) => {
  const token = (req as any).token;
  const user = (req as any).user;

  await db.addLog(user.id, "info", "User session logged out.");
  res.json({ message: "Successfully logged out of active session" });
});

// ==========================================
// USER DASHBOARD / SETTINGS ENDPOINTS
// ==========================================

// Get profile
app.get("/api/user/profile", authenticateToken, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const currentRawQr = userCurrentQrs.get(user.id);
  const qrUrl = currentRawQr
    ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(currentRawQr)}`
    : undefined;

  res.json({
    user: {
      id: user.id,
      email: user.email,
      botName: user.botName,
      systemInstruction: user.systemInstruction,
      whatsappStatus: user.whatsappStatus,
      isPaused: user.isPaused,
      isAdmin: user.isAdmin,
      autoReplyDelaySeconds: user.autoReplyDelaySeconds,
      lastActiveAt: user.lastActiveAt,
      geminiApiKey: user.geminiApiKey ? `${user.geminiApiKey.substring(0, 5)}...${user.geminiApiKey.substring(user.geminiApiKey.length - 4)}` : "",
      qrUrl: qrUrl
    }
  });
});

// Update profile settings
app.post("/api/user/update-settings", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { geminiApiKey, botName, systemInstruction, isPaused, autoReplyDelaySeconds, autoReplySeenCancelSeconds } = req.body;

    const updates: any = {};
    if (typeof geminiApiKey === "string") updates.geminiApiKey = geminiApiKey.trim();
    if (typeof botName === "string" && botName.trim().length > 0) updates.botName = botName.trim();
    if (typeof systemInstruction === "string" && systemInstruction.trim().length > 0) updates.systemInstruction = systemInstruction.trim();
    if (typeof isPaused === "boolean") updates.isPaused = isPaused;
    if (autoReplyDelaySeconds !== undefined) updates.autoReplyDelaySeconds = normalizeDelaySeconds(autoReplyDelaySeconds);
    if (autoReplySeenCancelSeconds !== undefined) updates.autoReplySeenCancelSeconds = normalizeSeenCancelSeconds(autoReplySeenCancelSeconds);

    const updatedUser = await db.updateUser(user.id, updates);

    // Log the configuration settings update
    await db.addLog(
      user.id,
      "success",
      `AI Configuration updated: Named "${updatedUser.botName}". Auto-reply is ${updatedUser.isPaused ? "PAUSED" : "ACTIVE"}. Delay set to ${updatedUser.autoReplyDelaySeconds}s. Seen cancel window set to ${updatedUser.autoReplySeenCancelSeconds}s.`
    );

    res.json({
      message: "AI Agent settings saved successfully.",
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        botName: updatedUser.botName,
        systemInstruction: updatedUser.systemInstruction,
        whatsappStatus: updatedUser.whatsappStatus,
        isPaused: updatedUser.isPaused,
        isAdmin: updatedUser.isAdmin,
        autoReplyDelaySeconds: updatedUser.autoReplyDelaySeconds,
        autoReplySeenCancelSeconds: updatedUser.autoReplySeenCancelSeconds,
        lastActiveAt: updatedUser.lastActiveAt,
        geminiApiKey: updatedUser.geminiApiKey ? `${updatedUser.geminiApiKey.substring(0, 5)}...${updatedUser.geminiApiKey.substring(updatedUser.geminiApiKey.length - 4)}` : ""
      }
    });
  } catch (error: any) {
    console.error("Settings update error:", error);
    res.status(500).json({ error: "Failed to save AI configuration settings." });
  }
});

// Get user logs
app.get("/api/user/logs", authenticateToken, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const logs = await db.getLogs(user.id);
  res.json({ logs });
});

// Get user chats
app.get("/api/user/chats", authenticateToken, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const chats = await db.getChats(user.id);
  res.json({ chats });
});

app.get("/api/public/stats", async (_req: Request, res: Response) => {
  const stats = await db.getPublicStats();
  res.json(stats);
});

app.get("/api/admin/users", authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  const users = await db.getAdminUsers();
  const activeUsers = await db.getActiveUserCount();
  const totalAiRepliesSent = await db.getTotalAiRepliesSent();

  res.json({
    users,
    activeUsers,
    totalUsers: users.length,
    totalAiRepliesSent
  });
});

// Admin: update a user's attributes safely (only provided fields are changed)
app.post("/api/admin/update-user", authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const { id, isAdmin, isPaused, autoReplyDelaySeconds } = req.body;

    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "Missing or invalid user id." });
      return;
    }

    const updates: any = {};
    if (typeof isAdmin === "boolean") updates.isAdmin = isAdmin;
    if (typeof isPaused === "boolean") updates.isPaused = isPaused;
    if (autoReplyDelaySeconds !== undefined) updates.autoReplyDelaySeconds = normalizeDelaySeconds(autoReplyDelaySeconds);

    const before = await db.getUserById(id);
    const updated = await db.updateUser(id, updates);

    await db.addLog(actor.id, "info", `Admin ${actor.email} updated user ${updated.email} (${id}): ${JSON.stringify(updates)}`);

    res.json({ before, user: updated });
  } catch (error: any) {
    console.error("Admin update-user error:", error);
    res.status(500).json({ error: "Failed to update user." });
  }
});

// Clear user chats
app.post("/api/user/chats/clear", authenticateToken, async (req: Request, res: Response) => {
  const user = (req as any).user;
  await db.clearChats(user.id);
  await db.addLog(user.id, "info", "Cleared chat logs simulation.");
  res.json({ message: "Simulated chat history cleared." });
});

// Helper to query Gemini AI for real WhatsApp events
async function generateGeminiResponseForUser(user: any, sender: string, messageText: string): Promise<string> {
  const apiKey = user.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing API Key. Neither user custom key nor default server key is defined.");
  }

  const ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });

  const promptContext = `
You are the personal AI Auto-Responder designated for a user's WhatsApp.
The sender profile is: ${sender}.
The sender wrote: "${messageText}".

Please compose an elegant, conversational, and helpful reply. Always reply in first-person as an intelligent personal assistant bot representing ${user.botName}. 

CRITICAL CHAT FORMAT:
Keep your answer concise (1-3 sentences maximum). Avoid overly long or formal paragraphs. Match the immediate chat style. Never output system formatting.
`;

  const aiResponse = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: promptContext,
    config: {
      systemInstruction: user.systemInstruction,
      temperature: 0.7
    }
  });

  return aiResponse.text || "I was unable to formulate a message right now.";
}

// Launches/restarts a real Baileys connection for a specific user
async function startWhatsAppSocket(userId: string): Promise<void> {
  try {
    const user = await db.getUserById(userId);
    if (!user) return;

    // Disconnect any existing session
    if (activeSockets.has(userId)) {
      try {
        const oldSock = activeSockets.get(userId);
        oldSock.ev.removeAllListeners("connection.update");
        oldSock.ev.removeAllListeners("creds.update");
        oldSock.ev.removeAllListeners("messages.upsert");
        await oldSock.end(undefined);
      } catch (e) {
        // ignore
      }
      activeSockets.delete(userId);
    }

    await db.updateUser(userId, { whatsappStatus: "Loading QR Code" });
    await db.addLog(userId, "info", "Starting headless WhatsApp worker state machine...");

    const { default: makeWASocket, DisconnectReason, Browsers, WAMessageStatus } = await import("@whiskeysockets/baileys");
    const { state, saveCreds } = await createMongoAuthState(userId);

    const sock = makeWASocket({
      auth: state,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: true,
      printQRInTerminal: false,
      logger: (await import("pino")).default({ level: "silent" }) as any,
    });

    activeSockets.set(userId, sock);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        userCurrentQrs.set(userId, qr);
        void db.updateUser(userId, { whatsappStatus: "Connecting" });
        void db.addLog(userId, "info", "New scannable QR Code generated for pairing.");
      }

      if (connection === "open") {
        const phone = sock.user?.id.split(":")[0] || sock.user?.id;
        const formattedPhone = phone ? `+${phone}` : "Linked Device";
        activePairingSessions.delete(userId);
        void db.updateUser(userId, {
          whatsappStatus: "Authenticated",
          whatsappNumber: formattedPhone
        });
        void db.addLog(userId, "success", `WhatsApp successfully connected to device ${formattedPhone}`);
        userCurrentQrs.delete(userId);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const latestUser = await db.getUserById(userId);
        const isAuthenticated = latestUser?.whatsappStatus === "Authenticated";
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const pairingInProgress = activePairingSessions.has(userId) || latestUser?.whatsappStatus === "Connecting" || latestUser?.whatsappStatus === "Loading QR Code";
        
        void db.addLog(userId, "warning", `WhatsApp connection closed. Status code: ${statusCode || "unknown"}. Reconnecting: ${shouldReconnect}`);

        if (!isAuthenticated && pairingInProgress) {
          userCurrentQrs.delete(userId);
          void db.updateUser(userId, { whatsappStatus: "Connecting", whatsappNumber: latestUser?.whatsappNumber });
          setTimeout(() => {
            startWhatsAppSocket(userId);
          }, 2500);
          return;
        }

        if (!isAuthenticated && !pairingInProgress) {
          activePairingSessions.delete(userId);
          userCurrentQrs.delete(userId);
          void db.updateUser(userId, {
            whatsappStatus: "Disconnected",
            whatsappNumber: undefined
          });
          return;
        }

        if (shouldReconnect) {
          // Re-initialize socket in background
          setTimeout(() => {
            startWhatsAppSocket(userId);
          }, 5000);
        } else {
          void db.updateUser(userId, {
            whatsappStatus: "Disconnected",
            whatsappNumber: undefined
          });
          void db.addLog(userId, "warning", "WhatsApp session unlinked/logged out by user.");
          activeSockets.delete(userId);
          userCurrentQrs.delete(userId);
          pendingAutoReplies.delete(userId);
        }
      }
    });

    sock.ev.on("messages.upsert", async (m: any) => {
      try {
        const msg = m.messages[0];
        if (m.type === "notify") {
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
          const senderJid = msg.key.remoteJid;
          const senderName = msg.pushName || senderJid?.split("@")[0] || "Someone";

          if (!text || !senderJid) {
            return;
          }

          if (msg.key.fromMe) {
            clearPendingAutoReply(userId, senderJid);
            await db.addLog(userId, "info", `Manual reply detected for ${senderName}; pending auto-reply cancelled.`);
            return;
          }

          const userProfile = await db.getUserById(userId);
          if (!userProfile) return;

          await db.addChat(userId, {
            sender: senderName,
            text: text,
            isSimulated: false
          });
          await db.addLog(userId, "info", `Message received from ${senderName}: "${text}"`);

          if (userProfile.isPaused) {
            await db.addLog(userId, "warning", `Auto-reply to ${senderName} ignored because system is currently PAUSED.`);
            return;
          }

          scheduleAutoReply({
            userId,
            conversationKey: senderJid,
            senderLabel: senderName,
            messageText: text,
            isSimulated: false,
            delaySeconds: userProfile.autoReplyDelaySeconds,
            seenCancelWindowSeconds: userProfile.autoReplySeenCancelSeconds,
            receivedAt: Date.now(),
            sock,
            remoteJid: senderJid
          });

          await db.addLog(userId, "info", `Auto-reply scheduled for ${senderName} in ${normalizeDelaySeconds(userProfile.autoReplyDelaySeconds)} seconds.`);
        }
      } catch (msgErr: any) {
        console.error("Error processing messages.upsert event:", msgErr);
        void db.addLog(userId, "error", `Failed message handling: ${msgErr.message || msgErr.toString()}`);
      }
    });

    sock.ev.on("messages.update", async (updates: any[]) => {
      try {
        for (const update of updates || []) {
          const conversationKey = update?.key?.remoteJid;
          const isReadStatus = String(update?.status) === String(WAMessageStatus.READ);

          if (!conversationKey || update?.key?.fromMe || !isReadStatus) {
            continue;
          }

          const pending = pendingAutoReplies.get(userId)?.get(conversationKey);
          if (!pending || pending.seenCancelWindowSeconds <= 0) {
            continue;
          }

          const elapsedSeconds = (Date.now() - pending.receivedAt) / 1000;
          if (elapsedSeconds > pending.seenCancelWindowSeconds) {
            continue;
          }

          clearPendingAutoReply(userId, conversationKey);
          void db.addLog(
            userId,
            "info",
            `Read receipt from ${pending.senderLabel} arrived within ${pending.seenCancelWindowSeconds}s; pending auto-reply cancelled.`
          );
        }
      } catch (readErr: any) {
        console.error("Error processing messages.update event:", readErr);
      }
    });

  } catch (err: any) {
    console.error("Error starting WhatsApp session:", err);
    void db.addLog(userId, "error", `Connection state machine error: ${err.message || err.toString()}`);
    const currentUser = await db.getUserById(userId);
    if (activePairingSessions.has(userId) || currentUser?.whatsappStatus === "Connecting" || currentUser?.whatsappStatus === "Loading QR Code") {
      void db.updateUser(userId, { whatsappStatus: "Connecting" });
      setTimeout(() => {
        startWhatsAppSocket(userId);
      }, 2500);
      return;
    }

    void db.updateUser(userId, { whatsappStatus: "Disconnected" });
  }
}

// ==========================================
// WHATSAPP PAIRING ENDPOINTS (HYBRID MODEL)
// ==========================================

// Request/Generate connection QR
app.post("/api/whatsapp/connect", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    await resetWhatsAppSession(user.id, "Connecting");
    activePairingSessions.add(user.id);
    await db.addLog(user.id, "info", "Fresh QR session requested. Previous auth state cleared.");

    // Start socket in background
    void startWhatsAppSocket(user.id);

    res.json({
      message: "Connection initialized",
      whatsappStatus: "Loading QR Code"
    });
  } catch (error: any) {
    console.error("Connect error:", error);
    res.status(500).json({ error: "Failed to build WhatsApp pairing instance" });
  }
});

// Clear all WhatsApp session data and return to a clean disconnected state
app.post("/api/whatsapp/fresh-start", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    await resetWhatsAppSession(user.id);
    activePairingSessions.delete(user.id);
    await db.addLog(user.id, "warning", "Fresh start completed. All WhatsApp session data cleared.");

    res.json({
      message: "Fresh start completed. Start again with QR or phone number.",
      whatsappStatus: "Disconnected"
    });
  } catch (error: any) {
    console.error("Fresh start error:", error);
    res.status(500).json({ error: "Failed to complete fresh start reset." });
  }
});

// Connect via mobile number and generate WhatsApp pairing code
app.post("/api/whatsapp/connect-phone", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const normalized = normalizePhoneNumberForPairing(req.body?.phoneNumber);

    if (!normalized) {
      res.status(400).json({ error: "Enter a valid mobile number with country code (example: +8801XXXXXXXXX)." });
      return;
    }

    const latestUser = await db.getUserById(user.id);
    if (!latestUser) {
      res.status(404).json({ error: "User profile not found." });
      return;
    }

    if (latestUser.whatsappStatus === "Authenticated") {
      res.status(409).json({ error: "This account is already connected. Disconnect first to link another number." });
      return;
    }

    await resetWhatsAppSession(user.id, "Connecting");
    activePairingSessions.add(user.id);
    await db.addLog(user.id, "info", "Cleared previous auth state. Starting a fresh phone-number pairing session.");

    await db.updateUser(user.id, { whatsappNumber: normalized.displayNumber });

    await startWhatsAppSocket(user.id);

    const pairingCode = await requestPhonePairingCode(user.id, normalized.digits);
    await db.addLog(user.id, "success", `Pairing code generated for ${normalized.displayNumber}. Enter this code on your WhatsApp phone.`);

    res.json({
      message: "Pairing code generated successfully.",
      whatsappStatus: "Connecting",
      whatsappNumber: normalized.displayNumber,
      pairingCode
    });
  } catch (error: any) {
    console.error("Phone connect error:", error);
    res.status(500).json({ error: error.message || "Failed to generate phone pairing code." });
  }
});

// Disconnect from WhatsApp
app.post("/api/whatsapp/disconnect", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    await resetWhatsAppSession(user.id);
    activePairingSessions.delete(user.id);
    const updated = await db.getUserById(user.id);

    await db.addLog(user.id, "warning", "WhatsApp session terminated. Auto-responder offline.");
    res.json({
      message: "WhatsApp session disconnected.",
      whatsappStatus: updated?.whatsappStatus || "Disconnected"
    });
  } catch (error: any) {
    console.error("Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect WhatsApp connection" });
  }
});

// Simulate scan pairing (for easy sandbox experience)
app.post("/api/whatsapp/simulate-scan", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { phoneNumber } = req.body;

    const formattedNumber = phoneNumber ? phoneNumber.trim() : "+1 (555) 781-8051";

    const updated = await db.updateUser(user.id, {
      whatsappStatus: "Authenticated",
      whatsappNumber: formattedNumber
    });

    await db.addLog(user.id, "success", `WhatsApp successfully connected to device matching ${formattedNumber}`);

    res.json({
      message: "Pairing simulation verified.",
      whatsappStatus: updated.whatsappStatus,
      whatsappNumber: updated.whatsappNumber
    });
  } catch (error: any) {
    console.error("Scan simulation error:", error);
    res.status(500).json({ error: "Failed to complete pairing link scan simulation" });
  }
});

// ==========================================
// GEMINI INTELLIGENT ROUTING & SIMULATOR
// ==========================================

// Handle simulator message & Gemini auto-reply execution
app.post("/api/simulator/chat", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { fromName, messageText } = req.body;

    if (!messageText || !messageText.trim()) {
      res.status(400).json({ error: "Message content cannot be blank." });
      return;
    }

    const trimmedMsg = messageText.trim();
    const sender = fromName ? fromName.trim() : "+1 (555) 049-2195";
    const userProfile = await db.getUserById(user.id);
    if (!userProfile) {
      res.status(404).json({ error: "User profile not found." });
      return;
    }

    // 1. Add user message to historical chats
    const incomingChat = await db.addChat(user.id, {
      sender,
      text: trimmedMsg,
      isSimulated: true
    });

    await db.addLog(user.id, "info", `Incoming text on WhatsApp index from "${sender}": "${trimmedMsg}"`);

    // 2. Check configuration status (Pause mode)
    if (userProfile.isPaused) {
      const systemMessage = await db.addChat(user.id, {
        sender: "bot",
        text: `[System Notification: Bot is currently paused. Replier did not fire content.]`,
        isSimulated: true
      });
      await db.addLog(user.id, "warning", `Blocked response to message from ${sender} because auto-reply is currently PAUSED.`);
      res.json({
        incoming: incomingChat,
        reply: systemMessage,
        status: "paused"
      });
      return;
    }

    scheduleAutoReply({
      userId: user.id,
      conversationKey: sender,
      senderLabel: sender,
      messageText: trimmedMsg,
      isSimulated: true,
      delaySeconds: userProfile.autoReplyDelaySeconds,
      seenCancelWindowSeconds: userProfile.autoReplySeenCancelSeconds,
      receivedAt: Date.now()
    });

    await db.addLog(user.id, "info", `Auto-reply scheduled for ${sender} in ${normalizeDelaySeconds(userProfile.autoReplyDelaySeconds)} seconds.`);

    res.json({
      incoming: incomingChat,
      status: "scheduled"
    });

  } catch (error: any) {
    console.error("Simulator request error:", error);
    res.status(500).json({ error: "Failed to process testing message simulation." });
  }
});

// ==========================================
// STATIC ASSET SERVING & ENGINE INGRESS
// ==========================================

// Handle Vite middleware inside server for hot reloads
const startServer = async () => {
  await initializeDatabase();
  const httpServer = createHttpServer(app);
  const listenPort = await findAvailablePort(PORT);

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: {
          server: httpServer
        },
        hmr: {
          server: httpServer
        }
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  if (process.env.VERCEL !== "1") {
    httpServer.listen(listenPort, "0.0.0.0", () => {
      console.log(`WhatsApp-Gemini full-stack server running securely on http://localhost:${listenPort}`);
    });
  }
};

if (process.env.VERCEL !== "1") {
  void startServer().catch((err) => {
    console.error("Failed to boot full-stack integration server:", err);
  });
}

export { app };
