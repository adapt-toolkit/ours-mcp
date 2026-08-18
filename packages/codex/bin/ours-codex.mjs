#!/usr/bin/env node
import { runLauncher } from '../src/launcher.mjs';

try {
  process.exitCode = await runLauncher();
} catch (error) {
  process.stderr.write(`ours-codex: ${error.message}\n`);
  process.exitCode = 1;
}
