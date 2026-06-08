#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const requiredKeys = ["DB_HOST", "DB_USER", "DB_PASSWORD"];
const missingKeys = requiredKeys.filter((key) => !process.env[key]);

if (missingKeys.length > 0) {
  throw new Error(
    `[postgres-pmt-v3-products] Missing required environment variables: ${missingKeys.join(", ")}`,
  );
}

const url = new URL("postgresql://localhost/pmt_v3_products");
url.hostname = process.env.DB_HOST;
url.port = process.env.DB_PORT || "5432";
url.username = process.env.DB_USER;
url.password = process.env.DB_PASSWORD;

process.env.MCP_POSTGRES_URL = url.toString();

const launcherPath = "C:\\Users\\mayer\\.codex\\mcp\\start-postgres-mcp.mjs";
await import(pathToFileURL(launcherPath).href);
