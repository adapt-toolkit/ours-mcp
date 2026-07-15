#!/usr/bin/env node
import { runMonitorMcp } from '../dist/monitor-mcp.mjs';
runMonitorMcp().catch((error) => { process.stderr.write(`ours monitor MCP: ${error.message}\n`); process.exitCode = 1; });
