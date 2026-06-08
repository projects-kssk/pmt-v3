#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const envPath =
  "C:\\Users\\mayer\\OneDrive\\Desktop\\PMTV2-Production-Docker\\production-management-panel-v3-backend\\.env.development";

function parseEnv(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

if (!fs.existsSync(envPath)) {
  throw new Error(`[postgres-pmt-v2-dev] Missing PMTV2 dev env: ${envPath}`);
}

const devEnv = parseEnv(fs.readFileSync(envPath, "utf8"));
const requiredKeys = [
  "SUPABASE_PG_HOST",
  "SUPABASE_PG_PORT",
  "SUPABASE_PG_USER",
  "SUPABASE_PG_PASSWORD",
  "SUPABASE_PG_DB",
];
const missingKeys = requiredKeys.filter((key) => !devEnv[key]);

if (missingKeys.length > 0) {
  throw new Error(
    `[postgres-pmt-v2-dev] Missing required dev environment variables: ${missingKeys.join(", ")}`,
  );
}

if (devEnv.SUPABASE_PG_PORT !== "5434") {
  throw new Error(
    `[postgres-pmt-v2-dev] Refusing non-dev PostgreSQL port ${devEnv.SUPABASE_PG_PORT}; expected 5434 for Supabase 8002`,
  );
}

if (devEnv.SUPABASE_URL && !devEnv.SUPABASE_URL.endsWith(":8002")) {
  throw new Error(
    `[postgres-pmt-v2-dev] Refusing non-dev Supabase URL ${devEnv.SUPABASE_URL}; expected port 8002`,
  );
}

const url = new URL(`postgresql://localhost/${devEnv.SUPABASE_PG_DB}`);
url.hostname = devEnv.SUPABASE_PG_HOST;
url.port = devEnv.SUPABASE_PG_PORT;
url.username = devEnv.SUPABASE_PG_USER;
url.password = devEnv.SUPABASE_PG_PASSWORD;

process.env.MCP_POSTGRES_URL = url.toString();
process.env.MCP_POSTGRES_SEARCH_PATH = "devprod,public";
process.env.ALLOW_WRITES = "0";
process.env.POSTGRES_MCP_ALLOW_WRITES = "0";

const launcherPath = path.join(
  process.env.USERPROFILE,
  ".codex",
  "mcp",
  "start-postgres-mcp.mjs",
);
await import(pathToFileURL(launcherPath).href);
