import express, { Request, Response, NextFunction } from "express";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { db, hashPassword, initializeDatabase } from "./src/server/db.ts";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Active WhatsApp Web sockets tracking
const activeSockets = new Map<string, any>(); // User ID -> WASocket
const userCurrentQrs = new Map<string, string>(); // User ID -> Last raw QR string

// Custom Authentication Middleware
function authenticateToken(req: Request, res: Response, next: NextFunction) {
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

  const user = db.getUserById(userId);
  if (!user) {
    res.status(404).json({ error: "User profile not found." });
    return;
  }

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
app.post("/api/auth/signup", (req: Request, res: Response) => {
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
    const existing = db.getUserByEmail(email);
    if (existing) {
      res.status(422).json({ error: "An account with this email already exists." });
      return;
    }

    const hashedPassword = hashPassword(password);
    const user = db.createUser(email, hashedPassword);

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
        isPaused: user.isPaused
      }
    });
  } catch (error: any) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Internal server error during account registration." });
  }
});

// Login user
app.post("/api/auth/login", (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are both required." });
      return;
    }

    const hashedPassword = hashPassword(password);
    const user = db.verifyAndGetUser(email, hashedPassword);

    if (!user) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    // Generate login token
    const sessionToken = createSessionToken(user.id);

    db.addLog(user.id, "info", `Logged in from IP ${req.ip || "unknown"}`);

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
        geminiApiKey: user.geminiApiKey ? `${user.geminiApiKey.substring(0, 5)}...${user.geminiApiKey.substring(user.geminiApiKey.length - 4)}` : ""
      }
    });
  } catch (error: any) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error during authentication." });
  }
});

// Logout user
app.post("/api/auth/logout", authenticateToken, (req: Request, res: Response) => {
  const token = (req as any).token;
  const user = (req as any).user;

  db.addLog(user.id, "info", "User session logged out.");
  res.json({ message: "Successfully logged out of active session" });
});

// ==========================================
// USER DASHBOARD / SETTINGS ENDPOINTS
// ==========================================

// Get profile
app.get("/api/user/profile", authenticateToken, (req: Request, res: Response) => {
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
      geminiApiKey: user.geminiApiKey ? `${user.geminiApiKey.substring(0, 5)}...${user.geminiApiKey.substring(user.geminiApiKey.length - 4)}` : "",
      qrUrl: qrUrl
    }
  });
});

// Update profile settings
app.post("/api/user/update-settings", authenticateToken, (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { geminiApiKey, botName, systemInstruction, isPaused } = req.body;

    const updates: any = {};
    if (typeof geminiApiKey === "string") updates.geminiApiKey = geminiApiKey.trim();
    if (typeof botName === "string" && botName.trim().length > 0) updates.botName = botName.trim();
    if (typeof systemInstruction === "string" && systemInstruction.trim().length > 0) updates.systemInstruction = systemInstruction.trim();
    if (typeof isPaused === "boolean") updates.isPaused = isPaused;

    const updatedUser = db.updateUser(user.id, updates);

    // Log the configuration settings update
    db.addLog(
      user.id,
      "success",
      `AI Configuration updated: Named "${updatedUser.botName}". Auto-reply is ${updatedUser.isPaused ? "PAUSED" : "ACTIVE"}.`
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
        geminiApiKey: updatedUser.geminiApiKey ? `${updatedUser.geminiApiKey.substring(0, 5)}...${updatedUser.geminiApiKey.substring(updatedUser.geminiApiKey.length - 4)}` : ""
      }
    });
  } catch (error: any) {
    console.error("Settings update error:", error);
    res.status(500).json({ error: "Failed to save AI configuration settings." });
  }
});

// Get user logs
app.get("/api/user/logs", authenticateToken, (req: Request, res: Response) => {
  const user = (req as any).user;
  const logs = db.getLogs(user.id);
  res.json({ logs });
});

// Get user chats
app.get("/api/user/chats", authenticateToken, (req: Request, res: Response) => {
  const user = (req as any).user;
  const chats = db.getChats(user.id);
  res.json({ chats });
});

// Clear user chats
app.post("/api/user/chats/clear", authenticateToken, (req: Request, res: Response) => {
  const user = (req as any).user;
  db.clearChats(user.id);
  db.addLog(user.id, "info", "Cleared chat logs simulation.");
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
    const user = db.getUserById(userId);
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

    db.updateUser(userId, { whatsappStatus: "Loading QR Code" });
    db.addLog(userId, "info", "Starting headless WhatsApp worker state machine...");

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import("@whiskeysockets/baileys");
    const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), "data", "sessions", userId));

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: (await import("pino")).default({ level: "silent" }) as any,
    });

    activeSockets.set(userId, sock);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        userCurrentQrs.set(userId, qr);
        db.updateUser(userId, { whatsappStatus: "Connecting" });
        db.addLog(userId, "info", "New scannable QR Code generated for pairing.");
      }

      if (connection === "open") {
        const phone = sock.user?.id.split(":")[0] || sock.user?.id;
        const formattedPhone = phone ? `+${phone}` : "Linked Device";
        db.updateUser(userId, {
          whatsappStatus: "Authenticated",
          whatsappNumber: formattedPhone
        });
        db.addLog(userId, "success", `WhatsApp successfully connected to device ${formattedPhone}`);
        userCurrentQrs.delete(userId);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        db.addLog(userId, "warning", `WhatsApp connection closed. Status code: ${statusCode || "unknown"}. Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          // Re-initialize socket in background
          setTimeout(() => {
            startWhatsAppSocket(userId);
          }, 5000);
        } else {
          db.updateUser(userId, {
            whatsappStatus: "Disconnected",
            whatsappNumber: undefined
          });
          db.addLog(userId, "warning", "WhatsApp session unlinked/logged out by user.");
          activeSockets.delete(userId);
          userCurrentQrs.delete(userId);
        }
      }
    });

    sock.ev.on("messages.upsert", async (m: any) => {
      try {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === "notify") {
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
          const senderJid = msg.key.remoteJid;
          const senderName = msg.pushName || senderJid?.split("@")[0] || "Someone";

          if (text && senderJid) {
            const userProfile = db.getUserById(userId);
            if (!userProfile) return;

            // Save incoming history
            db.addChat(userId, {
              sender: senderName,
              text: text,
              isSimulated: false
            });
            db.addLog(userId, "info", `Message received from ${senderName}: "${text}"`);

            if (userProfile.isPaused) {
              db.addLog(userId, "warning", `Auto-reply to ${senderName} ignored because system is currently PAUSED.`);
              return;
            }

            db.addLog(userId, "ai", `Consulting Gemini auto-reply...`);
            const aiReply = await generateGeminiResponseForUser(userProfile, senderName, text);

            // Send reply through the socket
            await sock.sendMessage(senderJid, { text: aiReply });
            
            db.addChat(userId, {
              sender: "bot",
              text: aiReply,
              isSimulated: false
            });
            db.addLog(userId, "success", `Auto-replied back to ${senderName}.`);
          }
        }
      } catch (msgErr: any) {
        console.error("Error processing messages.upsert event:", msgErr);
        db.addLog(userId, "error", `Failed message handling: ${msgErr.message || msgErr.toString()}`);
      }
    });

  } catch (err: any) {
    console.error("Error starting WhatsApp session:", err);
    db.addLog(userId, "error", `Connection state machine error: ${err.message || err.toString()}`);
    db.updateUser(userId, { whatsappStatus: "Disconnected" });
  }
}

// ==========================================
// WHATSAPP PAIRING ENDPOINTS (HYBRID MODEL)
// ==========================================

// Request/Generate connection QR
app.post("/api/whatsapp/connect", authenticateToken, (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Start socket in background
    startWhatsAppSocket(user.id);

    res.json({
      message: "Connection initialized",
      whatsappStatus: "Loading QR Code"
    });
  } catch (error: any) {
    console.error("Connect error:", error);
    res.status(500).json({ error: "Failed to build WhatsApp pairing instance" });
  }
});

// Disconnect from WhatsApp
app.post("/api/whatsapp/disconnect", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Disconnect active socket
    if (activeSockets.has(user.id)) {
      try {
        const sock = activeSockets.get(user.id);
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("creds.update");
        sock.ev.removeAllListeners("messages.upsert");
        await sock.logout();
      } catch (e) {
        // ignore
      }
      activeSockets.delete(user.id);
    }
    userCurrentQrs.delete(user.id);

    const updated = db.updateUser(user.id, {
      whatsappStatus: "Disconnected",
      whatsappNumber: undefined
    });

    db.addLog(user.id, "warning", "WhatsApp session terminated. Auto-responder offline.");

    res.json({
      message: "WhatsApp session disconnected.",
      whatsappStatus: updated.whatsappStatus
    });
  } catch (error: any) {
    console.error("Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect WhatsApp connection" });
  }
});

// Simulate scan pairing (for easy sandbox experience)
app.post("/api/whatsapp/simulate-scan", authenticateToken, (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { phoneNumber } = req.body;

    const formattedNumber = phoneNumber ? phoneNumber.trim() : "+1 (555) 781-8051";

    const updated = db.updateUser(user.id, {
      whatsappStatus: "Authenticated",
      whatsappNumber: formattedNumber
    });

    db.addLog(user.id, "success", `WhatsApp successfully connected to device matching ${formattedNumber}`);

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

    // 1. Add user message to historical chats
    const incomingChat = db.addChat(user.id, {
      sender,
      text: trimmedMsg,
      isSimulated: true
    });

    db.addLog(user.id, "info", `Incoming text on WhatsApp index from "${sender}": "${trimmedMsg}"`);

    // 2. Check configuration status (Pause mode)
    if (user.isPaused) {
      const systemMessage = db.addChat(user.id, {
        sender: "bot",
        text: `[System Notification: Bot is currently paused. Replier did not fire content.]`,
        isSimulated: true
      });
      db.addLog(user.id, "warning", `Blocked response to message from ${sender} because auto-reply is currently PAUSED.`);
      res.json({
        incoming: incomingChat,
        reply: systemMessage,
        status: "paused"
      });
      return;
    }

    // 3. Auto-responding through Gemini AI
    try {
      // Find the appropriate API key. 
      // Prioritize user's saved key if specified; fallback to server environment process key.
      const apiKey = user.geminiApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
         throw new Error("Missing API Key. Neither user custom key nor default server key is defined.");
      }

      db.addLog(user.id, "ai", `Consulting Gemini AI with instructions set...`);

      // Initialize the genuine modern @google/genai SDK on the server side
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      // Execute generative modeling using gemini-3.5-flash
      const promptContext = `
You are the personal AI Auto-Responder designated for a user's WhatsApp.
The sender profile is: ${sender}.
The sender wrote: "${trimmedMsg}".

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

      const replyContent = aiResponse.text || "I was unable to formulate a message right now.";

      // 4. Save Bot Reply to Database
      const replyChat = db.addChat(user.id, {
        sender: "bot",
        text: replyContent,
        isSimulated: true
      });

      db.addLog(
        user.id, 
        "success", 
        `Auto-Replied successfully using Gemini. Reponded: "${replyContent.substring(0, 40)}${replyContent.length > 40 ? "..." : ""}"`
      );

      res.json({
        incoming: incomingChat,
        reply: replyChat,
        status: "replied"
      });

    } catch (aiError: any) {
      console.error("Gemini Generation Error:", aiError);
      db.addLog(user.id, "error", `Gemini API execution failed: ${aiError.message || aiError.toString()}`);
      
      const errorChat = db.addChat(user.id, {
        sender: "bot",
        text: `Error auto-responding using Gemini. Please review your settings or secrets panel. Details: ${aiError.message || "Failed request validation"}`,
        isSimulated: true
      });

      res.status(200).json({
        incoming: incomingChat,
        reply: errorChat,
        status: "error",
        error: aiError.message
      });
    }

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

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`WhatsApp-Gemini full-stack server running securely on http://localhost:${PORT}`);
    });
  }
};

if (process.env.VERCEL !== "1") {
  void startServer().catch((err) => {
    console.error("Failed to boot full-stack integration server:", err);
  });
}

export { app };
