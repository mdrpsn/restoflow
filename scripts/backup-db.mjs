#!/usr/bin/env node
/**
 * Backs up the real Postgres database via the running Docker container's own
 * pg_dump - no local Postgres client tools required. Keeps a rolling window
 * of the last N daily backups so disk usage doesn't grow unbounded.
 *
 * Usage:   npm run db:backup
 * Cron (once deployed on the VPS):
 *   0 3 * * * cd /path/to/restoflow && node scripts/backup-db.mjs >> backups/backup.log 2>&1
 */
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BACKUP_DIR = process.env.BACKUP_DIR || join(process.cwd(), "backups");
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);
const CONTAINER = process.env.DB_CONTAINER || "restoflow-db-1";
const DB_USER = process.env.DB_USER || "restoflow";
const DB_NAME = process.env.DB_NAME || "restoflow";

mkdirSync(BACKUP_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(BACKUP_DIR, `restoflow-${timestamp}.sql`);

console.log(`Backing up "${DB_NAME}" from container "${CONTAINER}"...`);
const dump = execSync(`docker exec ${CONTAINER} pg_dump -U ${DB_USER} ${DB_NAME}`, {
  maxBuffer: 1024 * 1024 * 512, // 512MB ceiling - plenty for this database's real size
});
writeFileSync(outFile, dump);
console.log(`Wrote ${outFile} (${(dump.length / 1024).toFixed(1)} KB)`);

// Prune backups older than KEEP_DAYS so this directory doesn't grow forever.
const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
const removed = [];
for (const file of readdirSync(BACKUP_DIR)) {
  if (!file.startsWith("restoflow-") || !file.endsWith(".sql")) continue;
  const filePath = join(BACKUP_DIR, file);
  if (statSync(filePath).mtimeMs < cutoff) {
    unlinkSync(filePath);
    removed.push(file);
  }
}
if (removed.length) {
  console.log(`Pruned ${removed.length} backup(s) older than ${KEEP_DAYS} days.`);
}
