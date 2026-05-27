import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import { User, ChatMessage, LogEntry } from "../types";

dotenv.config();

const DB_FILE = path.join(process.cwd(), "data", "db.json");
const MONGODB_URI = process.env.MONGODB_URI?.trim();
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME?.trim() || "whatsapp_gemini_agent";

interface StoredUser extends User {
  passwordHash: string;
}

interface DBStructure {
  users: StoredUser[];
  chats: Record<string, ChatMessage[]>;
  logs: Record<string, LogEntry[]>;
}

interface FileSnapshot {
  users: User[];
  chats: Record<string, ChatMessage[]>;
  logs: Record<string, LogEntry[]>;
  credentials?: Record<string, string>;
}

const emptySnapshot: DBStructure = {
  users: [],
  chats: {},
  logs: {}
};

let cache: DBStructure = { ...emptySnapshot };
let mongoClient: MongoClient | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let persistQueue: Promise<void> = Promise.resolve();

function ensureDataDirectory() {
  const directory = path.dirname(DB_FILE);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function ensureFileExists() {
  ensureDataDirectory();
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(emptySnapshot, null, 2), "utf-8");
  }
}

function normalizeUser(user: Partial<StoredUser> & Pick<StoredUser, "id" | "email" | "passwordHash">): StoredUser {
  return {
    id: user.id,
    email: user.email,
    geminiApiKey: user.geminiApiKey ?? "",
    botName: user.botName ?? "Gemini Auto-Bot",
    systemInstruction:
      user.systemInstruction ??
      "You are an elegant, polite, and helpful personal WhatsApp auto-responder bot. Keep your replies concise, helpful, and natural, matching the style of message chat applications. Never use excessively long or formal paragraphs. Always write in a way suited to chat layouts.",
    whatsappStatus: user.whatsappStatus ?? "Disconnected",
    whatsappNumber: user.whatsappNumber,
    qrUrl: user.qrUrl,
    isPaused: user.isPaused ?? false,
    createdAt: user.createdAt ?? new Date().toISOString(),
    passwordHash: user.passwordHash
  };
}

function toPublicUser(user: StoredUser): User {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

function readFileSnapshot(): DBStructure {
  ensureFileExists();

  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(raw) as FileSnapshot & { users?: Array<Partial<User> & { id: string }> };
    const credentials = parsed.credentials || {};

    return {
      users: (parsed.users || []).map((user) =>
        normalizeUser({
          ...(user as User),
          id: user.id,
          email: user.email,
          passwordHash: credentials[user.id] || (user as any).passwordHash || ""
        })
      ),
      chats: parsed.chats || {},
      logs: parsed.logs || {}
    };
  } catch (error) {
    console.error("Failed to read local database snapshot, using an empty cache:", error);
    return { ...emptySnapshot };
  }
}

function writeFileSnapshot(snapshot: DBStructure) {
  ensureFileExists();

  const fileSnapshot: FileSnapshot & { credentials: Record<string, string> } = {
    users: snapshot.users.map(toPublicUser),
    chats: snapshot.chats,
    logs: snapshot.logs,
    credentials: snapshot.users.reduce<Record<string, string>>((acc, user) => {
      acc[user.id] = user.passwordHash;
      return acc;
    }, {})
  };

  fs.writeFileSync(DB_FILE, JSON.stringify(fileSnapshot, null, 2), "utf-8");
}

function getMongoDb() {
  if (!mongoClient) {
    throw new Error("MongoDB client is not ready.");
  }

  return mongoClient.db(MONGODB_DB_NAME);
}

function syncCache(snapshot: DBStructure) {
  cache = {
    users: snapshot.users.map((user) => normalizeUser(user)),
    chats: snapshot.chats || {},
    logs: snapshot.logs || {}
  };
}

function hasSnapshotData(snapshot: DBStructure) {
  return snapshot.users.length > 0 || Object.keys(snapshot.chats).length > 0 || Object.keys(snapshot.logs).length > 0;
}

async function loadMongoSnapshot(): Promise<DBStructure> {
  if (!mongoClient) {
    return { ...emptySnapshot };
  }

  const db = getMongoDb();
  const [userDocs, chatDocs, logDocs] = await Promise.all([
    db.collection<StoredUser>("users").find({}).toArray(),
    db.collection<{ userId: string; messages: ChatMessage[] }>("chats").find({}).toArray(),
    db.collection<{ userId: string; entries: LogEntry[] }>("logs").find({}).toArray()
  ]);

  return {
    users: userDocs.map((user) => normalizeUser(user)),
    chats: chatDocs.reduce<Record<string, ChatMessage[]>>((acc, doc) => {
      acc[doc.userId] = doc.messages || [];
      return acc;
    }, {}),
    logs: logDocs.reduce<Record<string, LogEntry[]>>((acc, doc) => {
      acc[doc.userId] = doc.entries || [];
      return acc;
    }, {})
  };
}

async function persistUsers() {
  if (!mongoClient) {
    writeFileSnapshot(cache);
    return;
  }

  const collection = getMongoDb().collection<StoredUser>("users");
  await Promise.all(cache.users.map((user) => collection.updateOne({ id: user.id }, { $set: user }, { upsert: true })));
}

async function persistChats(userId: string) {
  if (!mongoClient) {
    writeFileSnapshot(cache);
    return;
  }

  await getMongoDb().collection("chats").updateOne(
    { userId },
    { $set: { userId, messages: cache.chats[userId] || [] } },
    { upsert: true }
  );
}

async function persistLogs(userId: string) {
  if (!mongoClient) {
    writeFileSnapshot(cache);
    return;
  }

  await getMongoDb().collection("logs").updateOne(
    { userId },
    { $set: { userId, entries: cache.logs[userId] || [] } },
    { upsert: true }
  );
}

function enqueuePersist(task: () => Promise<void>) {
  persistQueue = persistQueue
    .then(() => task())
    .then(() => undefined)
    .catch((error) => {
      console.error("Failed to persist database state:", error);
    });
}

async function seedMongoFromSnapshot(snapshot: DBStructure) {
  if (!mongoClient) {
    return;
  }

  await persistUsers();

  await Promise.all(
    Object.entries(snapshot.chats).map(([userId, messages]) =>
      getMongoDb().collection("chats").updateOne(
        { userId },
        { $set: { userId, messages } },
        { upsert: true }
      )
    )
  );

  await Promise.all(
    Object.entries(snapshot.logs).map(([userId, entries]) =>
      getMongoDb().collection("logs").updateOne(
        { userId },
        { $set: { userId, entries } },
        { upsert: true }
      )
    )
  );
}

export async function initializeDatabase() {
  if (initialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const fileSnapshot = readFileSnapshot();

    if (!MONGODB_URI) {
      syncCache(fileSnapshot);
      initialized = true;
      return;
    }

    try {
      mongoClient = new MongoClient(MONGODB_URI);
      await mongoClient.connect();

      const mongoSnapshot = await loadMongoSnapshot();
      if (hasSnapshotData(mongoSnapshot)) {
        syncCache(mongoSnapshot);
      } else {
        syncCache(fileSnapshot);
        if (hasSnapshotData(fileSnapshot)) {
          await seedMongoFromSnapshot(fileSnapshot);
        }
      }

      initialized = true;
      console.log(`Connected to MongoDB database \"${MONGODB_DB_NAME}\" for app persistence.`);
    } catch (error) {
      mongoClient = null;
      syncCache(fileSnapshot);
      initialized = true;
      console.error("MongoDB initialization failed. Falling back to local file storage:", error);
    }
  })();

  return initPromise;
}

// Hashing helper
export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export const db = {
  getUsers: (): User[] => {
    return cache.users.map(toPublicUser);
  },

  getUserById: (id: string): User | undefined => {
    const user = cache.users.find((entry) => entry.id === id);
    return user ? toPublicUser(user) : undefined;
  },

  getUserByEmail: (email: string): User | undefined => {
    const user = cache.users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
    return user ? toPublicUser(user) : undefined;
  },

  createUser: (email: string, passwordHash: string): User => {
    const newUser = normalizeUser({
      id: crypto.randomUUID(),
      email,
      geminiApiKey: "",
      botName: "Gemini Auto-Bot",
      systemInstruction:
        "You are an elegant, polite, and helpful personal WhatsApp auto-responder bot. Keep your replies concise, helpful, and natural, matching the style of message chat applications. Never use excessively long or formal paragraphs. Always write in a way suited to chat layouts.",
      whatsappStatus: "Disconnected",
      isPaused: false,
      createdAt: new Date().toISOString(),
      passwordHash
    });

    cache.users.push(newUser);
    cache.logs[newUser.id] = [
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: "success",
        message: "Account created successfully. Welcome to WhatsApp Gemini Agent dashboard!"
      }
    ];
    cache.chats[newUser.id] = [
      {
        id: crypto.randomUUID(),
        sender: "bot",
        text: "System: Auto-responder service initialized. Use the Live Sandbox on the right or link your WhatsApp device to test replies immediately.",
        timestamp: new Date().toISOString(),
        isSimulated: true
      }
    ];

    void enqueuePersist(async () => {
      await persistUsers();
      await persistChats(newUser.id);
      await persistLogs(newUser.id);
    });

    return toPublicUser(newUser);
  },

  verifyAndGetUser: (email: string, passwordHash: string): User | null => {
    const user = cache.users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      return null;
    }

    return user.passwordHash === passwordHash ? toPublicUser(user) : null;
  },

  updateUser: (id: string, updates: Partial<User>): User => {
    const index = cache.users.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`User with ID ${id} not found`);
    }

    cache.users[index] = normalizeUser({
      ...cache.users[index],
      ...updates,
      passwordHash: cache.users[index].passwordHash
    });

    void enqueuePersist(async () => {
      await persistUsers();
    });

    return toPublicUser(cache.users[index]);
  },

  getChats: (userId: string): ChatMessage[] => {
    return cache.chats[userId] || [];
  },

  addChat: (userId: string, chat: Omit<ChatMessage, "id" | "timestamp">): ChatMessage => {
    if (!cache.chats[userId]) {
      cache.chats[userId] = [];
    }

    const newChat: ChatMessage = {
      ...chat,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString()
    };

    cache.chats[userId].push(newChat);
    if (cache.chats[userId].length > 100) {
      cache.chats[userId].shift();
    }

    void enqueuePersist(async () => {
      await persistChats(userId);
    });

    return newChat;
  },

  clearChats: (userId: string) => {
    cache.chats[userId] = [];

    void enqueuePersist(async () => {
      await persistChats(userId);
    });
  },

  getLogs: (userId: string): LogEntry[] => {
    return cache.logs[userId] || [];
  },

  addLog: (userId: string, type: LogEntry["type"], message: string): LogEntry => {
    if (!cache.logs[userId]) {
      cache.logs[userId] = [];
    }

    const newLog: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      message
    };

    cache.logs[userId].unshift(newLog);
    if (cache.logs[userId].length > 50) {
      cache.logs[userId].pop();
    }

    void enqueuePersist(async () => {
      await persistLogs(userId);
    });

    return newLog;
  }
};
