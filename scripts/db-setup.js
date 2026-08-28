#!/usr/bin/env node
/**
 * Apply the database schema to Supabase and report what is there.
 * Idempotent — safe to run against an existing project.
 */
import { migrate, verifyConnection, query, closePool } from '../src/db.js';

try {
  const conn = await verifyConnection();
  console.log(`Connected to ${conn.version} at ${conn.label}`);

  await migrate();
  console.log('Schema applied.');

  const tables = await query(`
    SELECT c.relname AS table, c.relrowsecurity AS rls,
           (SELECT COUNT(*) FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::int AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`);

  for (const t of tables) {
    const { n } = await query(`SELECT COUNT(*)::int AS n FROM ${t.table}`).then((r) => r[0]);
    console.log(`  ${t.table.padEnd(14)} ${String(t.columns).padStart(2)} cols  ${String(n).padStart(6)} rows  RLS ${t.rls ? 'on' : 'OFF'}`);
  }
} catch (err) {
  console.error(`\nFailed: ${err.message}\n`);
  await closePool();
  process.exit(1);
}
await closePool();
