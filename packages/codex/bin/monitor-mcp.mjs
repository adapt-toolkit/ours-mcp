#!/usr/bin/env node
import { runMonitorMcp } from '../src/monitor-mcp.mjs';
runMonitorMcp().catch((error) => { process.stderr.write(`ours monitor MCP: ${error.message}\n`); process.exitCode = 1; });

