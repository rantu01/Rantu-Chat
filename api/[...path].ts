import { app } from "../server.ts";
import { initializeDatabase } from "../src/server/db.ts";

export default async function handler(req: any, res: any) {
  await initializeDatabase();
  return app(req, res);
}