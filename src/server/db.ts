import crypto from "crypto";
import dotenv from "dotenv";
import { MongoClient, type Collection, type Db } from "mongodb";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalKeyStore
} from "@whiskeysockets/baileys";
import { User, ChatMessage, LogEntry } from "../types";

dotenv.config({ path: ".env.local" });
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI?.trim();
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME?.trim() || "rantuChat";

const COLLECTIONS = {
  users: "users",
  chats: "chats",
  logs: "logs",
  whatsappAuthCreds: "whatsapp_auth_creds",
  whatsappAuthKeys: "whatsapp_auth_keys"
} as const;

interface StoredUser extends User {
  passwordHash: string;
}

interface ChatDocument {
  userId: string;
  messages: ChatMessage[];
}

interface LogDocument {
  userId: string;
  entries: LogEntry[];
}

interface WhatsAppAuthCredsDocument {
  userId: string;
  payload: string;
  updatedAt: Date;
}

interface WhatsAppAuthKeyDocument {
  userId: string;
  keyType: string;
  keyId: string;
  payload: string | null;
  updatedAt: Date;
}

const defaultSystemInstruction =
  "You are an elegant, polite, and helpful personal WhatsApp auto-responder bot. Keep your replies concise, helpful, and natural, matching the style of message chat applications. Never use excessively long or formal paragraphs. Always write in a way suited to chat layouts.";

const emptyState = {
  users: [] as StoredUser[],
  chats: {} as Record<string, ChatMessage[]>,
  logs: {} as Record<string, LogEntry[]>
};

let mongoClient: MongoClient | null = null;
let database: Db | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let cache = structuredClone(emptyState);

function requireDatabase() {
  if (!database) {
    throw new Error("MongoDB has not been initialized yet. Call initializeDatabase() first.");
  }

  return database;
}

function getCollection<T>(name: string): Collection<T> {
  return requireDatabase().collection<T>(name);
}

function normalizeUser(user: Partial<StoredUser> & Pick<StoredUser, "id" | "email" | "passwordHash">): StoredUser {
  return {
    id: user.id,
    email: user.email,
    geminiApiKey: user.geminiApiKey ?? "",
    botName: user.botName ?? "Gemini Auto-Bot",
    systemInstruction: user.systemInstruction ?? defaultSystemInstruction,
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

function encodeMongoValue(value: unknown) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function decodeMongoValue<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T;
}

function updateUserCache(updatedUser: StoredUser) {
  const index = cache.users.findIndex((entry) => entry.id === updatedUser.id);
  if (index === -1) {
    cache.users.push(updatedUser);
  } else {
    cache.users[index] = updatedUser;
  }
}

function updateChatCache(userId: string, messages: ChatMessage[]) {
  cache.chats[userId] = messages;
}

function updateLogCache(userId: string, entries: LogEntry[]) {
  cache.logs[userId] = entries;
}

async function ensureIndexes() {
  await Promise.all([
    getCollection<StoredUser>(COLLECTIONS.users).createIndex({ id: 1 }, { unique: true }),
    getCollection<StoredUser>(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true }),
    getCollection<ChatDocument>(COLLECTIONS.chats).createIndex({ userId: 1 }, { unique: true }),
    getCollection<LogDocument>(COLLECTIONS.logs).createIndex({ userId: 1 }, { unique: true }),
    getCollection<WhatsAppAuthCredsDocument>(COLLECTIONS.whatsappAuthCreds).createIndex({ userId: 1 }, { unique: true }),
    getCollection<WhatsAppAuthKeyDocument>(COLLECTIONS.whatsappAuthKeys).createIndex({ userId: 1, keyType: 1, keyId: 1 }, { unique: true })
  ]);
}

async function loadApplicationCache() {
  const [userDocs, chatDocs, logDocs] = await Promise.all([
    getCollection<StoredUser>(COLLECTIONS.users).find({}).toArray(),
    getCollection<ChatDocument>(COLLECTIONS.chats).find({}).toArray(),
    getCollection<LogDocument>(COLLECTIONS.logs).find({}).toArray()
  ]);

  cache = {
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

async function persistUserDocument(user: StoredUser) {
  await getCollection<StoredUser>(COLLECTIONS.users).updateOne(
    { id: user.id },
    { $set: user },
    { upsert: true }
  );
  updateUserCache(user);
}

async function persistChatDocument(userId: string, messages: ChatMessage[]) {
  await getCollection<ChatDocument>(COLLECTIONS.chats).updateOne(
    { userId },
    { $set: { userId, messages } },
    { upsert: true }
  );
  updateChatCache(userId, messages);
}

async function persistLogDocument(userId: string, entries: LogEntry[]) {
  await getCollection<LogDocument>(COLLECTIONS.logs).updateOne(
    { userId },
    { $set: { userId, entries } },
    { upsert: true }
  );
  updateLogCache(userId, entries);
}

export async function initializeDatabase() {
  if (initialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!MONGODB_URI) {
      throw new Error("MONGODB_URI is required. The application now uses MongoDB exclusively.");
    }

    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    database = mongoClient.db(MONGODB_DB_NAME);

    await ensureIndexes();
    await loadApplicationCache();

    initialized = true;
    console.log(`Connected to MongoDB database \"${MONGODB_DB_NAME}\" for app persistence.`);
  })().catch((error) => {
    initPromise = null;
    throw error;
  });

  return initPromise;
}

export function getMongoDb() {
  return requireDatabase();
}

export async function createMongoAuthState(userId: string): Promise<{ state: { creds: AuthenticationCreds; keys: SignalKeyStore }; saveCreds: () => Promise<void> }> {
  await initializeDatabase();

  const credsCollection = getCollection<WhatsAppAuthCredsDocument>(COLLECTIONS.whatsappAuthCreds);
  const keysCollection = getCollection<WhatsAppAuthKeyDocument>(COLLECTIONS.whatsappAuthKeys);

  const existingCreds = await credsCollection.findOne({ userId });
  const creds = existingCreds ? decodeMongoValue<AuthenticationCreds>(existingCreds.payload) : initAuthCreds();

  const state: { creds: AuthenticationCreds; keys: SignalKeyStore } = {
    creds,
    keys: {
      get: async (type, ids) => {
        const docs = await keysCollection.find({ userId, keyType: type, keyId: { $in: ids } }).toArray();
        const data: Record<string, any> = {};

        for (const id of ids) {
          data[id] = undefined;
        }

        for (const doc of docs) {
          if (doc.payload == null) {
            data[doc.keyId] = null;
            continue;
          }

          const value = decodeMongoValue<any>(doc.payload);
          data[doc.keyId] = type === "app-state-sync-key" && value ? proto.Message.AppStateSyncKeyData.fromObject(value) : value;
        }

        return data;
      },
      set: async (data) => {
        const tasks: Promise<unknown>[] = [];

        for (const keyType of Object.keys(data)) {
          const entries = data[keyType as keyof SignalDataSet] || {};

          for (const [keyId, value] of Object.entries(entries)) {
            if (value == null) {
              tasks.push(keysCollection.deleteOne({ userId, keyType, keyId }));
              continue;
            }

            tasks.push(
              keysCollection.updateOne(
                { userId, keyType, keyId },
                {
                  $set: {
                    userId,
                    keyType,
                    keyId,
                    payload: encodeMongoValue(value),
                    updatedAt: new Date()
                  }
                },
                { upsert: true }
              )
            );
          }
        }

        await Promise.all(tasks);
      }
    }
  };

  return {
    state,
    saveCreds: async () => {
      await credsCollection.updateOne(
        { userId },
        {
          $set: {
            userId,
            payload: encodeMongoValue(state.creds),
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    }
  };
}

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export const db = {
  getUsers: async (): Promise<User[]> => cache.users.map(toPublicUser),

  getUserById: async (id: string): Promise<User | undefined> => {
    const user = cache.users.find((entry) => entry.id === id);
    return user ? toPublicUser(user) : undefined;
  },

  getUserByEmail: async (email: string): Promise<User | undefined> => {
    const user = cache.users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
    return user ? toPublicUser(user) : undefined;
  },

  createUser: async (email: string, passwordHash: string): Promise<User> => {
    const newUser = normalizeUser({
      id: crypto.randomUUID(),
      email,
      geminiApiKey: "",
      botName: "Gemini Auto-Bot",
      systemInstruction: defaultSystemInstruction,
      whatsappStatus: "Disconnected",
      isPaused: false,
      createdAt: new Date().toISOString(),
      passwordHash
    });

    await persistUserDocument(newUser);

    const now = new Date().toISOString();
    const welcomeLog: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: now,
      type: "success",
      message: "Account created successfully. Welcome to WhatsApp Gemini Agent dashboard!"
    };
    const welcomeChat: ChatMessage = {
      id: crypto.randomUUID(),
      sender: "bot",
      text: "System: Auto-responder service initialized. Use the Live Sandbox on the right or link your WhatsApp device to test replies immediately.",
      timestamp: now,
      isSimulated: true
    };

    await Promise.all([
      persistLogDocument(newUser.id, [welcomeLog]),
      persistChatDocument(newUser.id, [welcomeChat])
    ]);

    return toPublicUser(newUser);
  },

  verifyAndGetUser: async (email: string, passwordHash: string): Promise<User | null> => {
    const user = cache.users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      return null;
    }

    return user.passwordHash === passwordHash ? toPublicUser(user) : null;
  },

  updateUser: async (id: string, updates: Partial<User>): Promise<User> => {
    const existing = cache.users.find((entry) => entry.id === id);
    if (!existing) {
      throw new Error(`User with ID ${id} not found`);
    }

    const updatedUser = normalizeUser({
      ...existing,
      ...updates,
      passwordHash: existing.passwordHash
    });

    await persistUserDocument(updatedUser);
    return toPublicUser(updatedUser);
  },

  getChats: async (userId: string): Promise<ChatMessage[]> => cache.chats[userId] || [],

  addChat: async (userId: string, chat: Omit<ChatMessage, "id" | "timestamp">): Promise<ChatMessage> => {
    const messages = cache.chats[userId] ? [...cache.chats[userId]] : [];
    const newChat: ChatMessage = {
      ...chat,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString()
    };

    messages.push(newChat);
    if (messages.length > 100) {
      messages.shift();
    }

    await persistChatDocument(userId, messages);
    return newChat;
  },

  clearChats: async (userId: string) => {
    await persistChatDocument(userId, []);
  },

  getLogs: async (userId: string): Promise<LogEntry[]> => cache.logs[userId] || [],

  addLog: async (userId: string, type: LogEntry["type"], message: string): Promise<LogEntry> => {
    const entries = cache.logs[userId] ? [...cache.logs[userId]] : [];
    const newLog: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      message
    };

    entries.unshift(newLog);
    if (entries.length > 50) {
      entries.pop();
    }

    await persistLogDocument(userId, entries);
    return newLog;
  }
};
