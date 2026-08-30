import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";

function safeName(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export class FileYoutubeAutomationStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.recordsDir = path.join(rootDir, "records");
    this.oauthDir = path.join(rootDir, "oauth");
    this.locks = new Map();
    fs.mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.oauthDir, { recursive: true, mode: 0o700 });
  }

  recordPath(uid) {
    return path.join(this.recordsDir, `${safeName(uid)}.json`);
  }

  oauthPath(state) {
    return path.join(this.oauthDir, `${safeName(state)}.json`);
  }

  async withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  async get(uid) {
    return readJson(this.recordPath(uid));
  }

  async update(uid, updater) {
    return this.withLock(`record:${uid}`, async () => {
      const current = (await this.get(uid)) || { uid, version: 1 };
      const next = await updater(structuredClone(current));
      if (!next) return current;
      next.uid = uid;
      next.version = Number.isSafeInteger(next.version) ? next.version : 1;
      next.updatedAt = Date.now();
      await this.writeAtomic(this.recordPath(uid), next);
      return structuredClone(next);
    });
  }

  async list() {
    const records = [];
    for (const entry of await fs.promises.readdir(this.recordsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes(".tmp-")) continue;
      try {
        const record = await readJson(path.join(this.recordsDir, entry.name));
        if (record?.uid) records.push(record);
      } catch {
        // One malformed user record must not stop every other automation.
      }
    }
    return records;
  }

  async createOauthState(state, value) {
    const filePath = this.oauthPath(state);
    await this.withLock(`oauth:${safeName(state)}`, async () => {
      if (await readJson(filePath)) throw new Error("OAuth state already exists.");
      await this.writeAtomic(filePath, value);
    });
  }

  async consumeOauthState(state) {
    const filePath = this.oauthPath(state);
    return this.withLock(`oauth:${safeName(state)}`, async () => {
      const value = await readJson(filePath);
      await fs.promises.rm(filePath, { force: true });
      return value;
    });
  }

  async sweepOauthStates(now = Date.now()) {
    for (const entry of await fs.promises.readdir(this.oauthDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.oauthDir, entry.name);
      const state = await readJson(filePath).catch(() => null);
      if (!state || state.expiresAt <= now) await fs.promises.rm(filePath, { force: true });
    }
  }

  async writeAtomic(filePath, value) {
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    await fs.promises.writeFile(tempPath, JSON.stringify(value), { mode: 0o600 });
    await fs.promises.rename(tempPath, filePath);
  }
}
