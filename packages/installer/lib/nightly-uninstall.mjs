// ─────────────────────────────────────────────────────────────────────────────
// NO LONGER REACHED BY ANY CODE PATH, DELIBERATELY AND TEMPORARILY.
//
// The nightly channel now runs the v3 installer end to end (owner ruling
// 2026-08-17: v3 SUBSUMES the nightly flow), so the two dispatch sites that led
// here — install.mjs and uninstall.mjs — were removed. This file is retained on
// purpose rather than deleted in the same commit.
//
// WHY IT IS STILL HERE. The behaviour inventory
// (/home/fleet/work/dev1-installer-notes/NIGHTLY-BEHAVIOUR-INVENTORY.md) lists
// what this flow does that v3 does not, and that list is not finished being
// carried across. Deleting the implementation and its tests before the one-for-one
// replacement exists is how a test that was covering something real gets removed
// alongside the ones that were not. Its tests still run and still pass, because
// they exercise this module directly.
//
// The retirement — removing this file and retiring each of its tests against a
// named v3 equivalent — is its own piece of work. Until then this is ORPHANED AND
// SAID SO, which is the opposite of the failure the staging existed to prevent:
// seven commits of feature reachable by no code path, with git reporting no
// conflict and nothing saying it had happened.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { heading, c } from './ui.mjs';
import { askLine, checkboxSelect } from './prompt.mjs';
import { canonHarnesses, coworkConfigPath, daemonEndpoint, tgConfigPath } from './logic.mjs';
import {
  atomicWriteConfig, restoreConfig, snapshotConfig, transactionalConfigUpdate,
} from './config.mjs';
import {
  readRegistry, profilesPath, removeHarnessAssociation, reverseApplicationIndex,
  validateRegistry, writeRegistry,
} from './profiles.mjs';

const YAML_START = '# >>> ours.network plugin (managed block)';
const YAML_END = '# <<< ours.network plugin';
const MD_START = '<!-- >>> ours.network plugin (managed block) -->';
const MD_END = '<!-- <<< ours.network plugin -->';
const line = (text = '') => process.stdout.write(`${text}\n`);
const say = (text) => line(`ours: ${text}`);

function readObject(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
    return value;
  } catch (error) { throw new Error(`${path} is corrupt or unsafe to inspect: ${error.message}`); }
}

function stripBlock(file, start, end) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  if (!text.includes(start)) return false;
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const value of lines) {
    if (!skipping && value.includes(start)) { skipping = true; continue; }
    if (skipping) { if (value.includes(end)) skipping = false; continue; }
    out.push(value);
  }
  writeFileSync(file, out.join('\n'));
  return true;
}

export function planNightlyUninstall(
  registry,
  {
    removeHarnesses = [], profileId, forgetProfile = false, removeDaemon = false,
    deleteData = false, connectorActions = {},
  } = {},
  connectorConfigs = {},
) {
  let next = validateRegistry(registry);
  const removedAssociations = [];
  for (const application of removeHarnesses) {
    const result = removeHarnessAssociation(next, application);
    next = result.registry;
    if (result.changed) removedAssociations.push({ application, profileId: result.previous });
  }
  const index = reverseApplicationIndex(next, connectorConfigs);
  const profile = profileId ? next.profiles[profileId] : undefined;
  if (profileId && !profile) throw new Error(`unknown daemon profile ${JSON.stringify(profileId)}`);
  const originalDependencies = profileId ? (index[profileId] || []) : [];
  const connectorPlans = [];
  const releasedConnectors = new Set();
  if (forgetProfile || removeDaemon) {
    for (const connector of ['telegram', 'rooms']) {
      if (!originalDependencies.includes(connector)) continue;
      const requested = connectorActions[connector];
      if (!requested) continue;
      const mode = requested.action;
      if (!['detach', 'uninstall', 'reassign'].includes(mode)) {
        throw new Error(`unknown ${connector} lifecycle action ${JSON.stringify(mode)}`);
      }
      let target;
      if (mode === 'reassign') {
        const toProfileId = requested.profileId;
        target = next.profiles[toProfileId];
        if (!target || toProfileId === profileId) {
          throw new Error(`${connector} reassignment requires a different retained profile`);
        }
        connectorPlans.push({
          type: 'connector-lifecycle', connector, mode, fromProfileId: profileId,
          toProfileId, profile: target,
        });
      } else {
        connectorPlans.push({ type: 'connector-lifecycle', connector, mode, fromProfileId: profileId });
      }
      releasedConnectors.add(connector);
    }
  }
  const dependencies = originalDependencies.filter((application) => !releasedConnectors.has(application));
  if ((forgetProfile || removeDaemon) && dependencies.length) {
    throw new Error(`profile ${profileId} is still required by: ${dependencies.join(', ')}`);
  }
  if (deleteData && !removeDaemon) throw new Error('data deletion requires selecting daemon removal');
  if (forgetProfile && removeDaemon) throw new Error('choose either metadata-only forgetting or daemon removal, not both');
  if (deleteData && !profile?.ownership.state) throw new Error(`profile ${profileId} state is external; the installer will not delete it`);
  const actions = [...connectorPlans];
  if (removeDaemon) {
    if (profile.ownership.service) actions.push({ type: 'uninstall-service', profileId, profile });
    else actions.push({ type: 'external-service-kept', profileId, profile });
    if (deleteData) actions.push({ type: 'delete-state', profileId, path: profile.stateDir });
    const profiles = { ...next.profiles };
    delete profiles[profileId];
    next = { ...next, profiles };
  } else if (forgetProfile) {
    actions.push({ type: 'forget-metadata', profileId, profile });
    const profiles = { ...next.profiles };
    delete profiles[profileId];
    next = { ...next, profiles };
  }
  const remainingIndex = reverseApplicationIndex(next, connectorConfigs);
  const retainedApplications = Object.values(remainingIndex).flat()
    .filter((application) => !releasedConnectors.has(application));
  const removeGlobalMcp = Object.keys(next.profiles).length === 0 && retainedApplications.length === 0;
  return { registry: next, removedAssociations, dependencies, actions, removeGlobalMcp };
}

const commandOk = (result) => result?.ok === true || result?.status === 0;

function parseConnectorLifecycle(raw, connector) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^detach$/i.test(value)) return { action: 'detach' };
  if (/^(?:uninstall|remove)$/i.test(value)) return { action: 'uninstall' };
  const reassign = value.match(/^(?:reassign|profile|move)(?::|\s+)([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/i);
  if (reassign) return { action: 'reassign', profileId: reassign[1] };
  throw new Error(`${connector} action must be detach, uninstall, or reassign:<profile-id>`);
}

function connectorRuntime(connector, home) {
  return connector === 'telegram'
    ? { path: tgConfigPath(process.env, home), bin: 'ours-tg-connector', pkg: '@ours.network/tg-connector' }
    : { path: coworkConfigPath(process.env, home), bin: 'ours-cowork', pkg: '@ours.network/cowork' };
}

function connectorConfigText(connector, current, action) {
  const next = { ...current };
  if (action.mode === 'reassign') {
    if (connector === 'telegram') {
      next.daemonUrl = daemonEndpoint(action.profile.port);
      next.daemonStateDir = action.profile.stateDir;
    } else {
      next.daemon = {
        ...(current.daemon && typeof current.daemon === 'object' ? current.daemon : {}),
        mode: 'external', endpoint: daemonEndpoint(action.profile.port), stateDir: action.profile.stateDir,
      };
    }
  } else if (connector === 'telegram') {
    delete next.daemonUrl;
    delete next.daemonStateDir;
  } else {
    delete next.daemon;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

function rollbackConnectorLifecycles(applied, run) {
  let ok = true;
  for (const item of [...applied].reverse()) {
    try { restoreConfig(item.runtime.path, item.before); }
    catch { ok = false; continue; }
    const restored = commandOk(run(item.runtime.bin, ['install-service']));
    ok &&= restored;
  }
  return ok;
}

function applyConnectorLifecycle(action, current, { home, run }) {
  const runtime = connectorRuntime(action.connector, home);
  const before = snapshotConfig(runtime.path);
  const text = connectorConfigText(action.connector, current, action);
  if (action.mode === 'reassign') {
    const applied = transactionalConfigUpdate(runtime.path, text, () => ({
      ok: commandOk(run(runtime.bin, ['install-service'])),
    }));
    return applied.ok
      ? { ok: true, runtime, before }
      : { ok: false, error: `${action.connector} reassignment failed during ${applied.stage}` };
  }
  const stopped = run(runtime.bin, ['uninstall-service']);
  if (!commandOk(stopped)) return { ok: false, error: `${action.connector} service detach failed` };
  try { atomicWriteConfig(runtime.path, text); }
  catch (error) {
    run(runtime.bin, ['install-service']);
    return { ok: false, error: `${action.connector} config detach failed: ${error.message}` };
  }
  return { ok: true, runtime, before };
}

function removeHarnessArtifacts(application, { run, npm, home }) {
  if (application === 'claude-code') {
    const plugin = run('claude', ['plugin', 'uninstall', 'ours@ours.network']);
    if (!commandOk(plugin)) return false;
    const market = run('claude', ['plugin', 'marketplace', 'remove', 'ours.network']);
    return commandOk(market);
  }
  if (application === 'codex') {
    const plugin = run('codex', ['plugin', 'remove', 'ours@ours-codex-marketplace']);
    if (!commandOk(plugin)) return false;
    const market = run('codex', ['plugin', 'marketplace', 'remove', 'ours-codex-marketplace']);
    if (!commandOk(market)) return false;
    const codex = process.env.CODEX_DIR || join(home, '.codex');
    const skills = process.env.SKILLS_DIR || join(home, '.agents', 'skills');
    stripBlock(join(codex, 'config.toml'), YAML_START, YAML_END);
    stripBlock(join(codex, 'AGENTS.md'), MD_START, MD_END);
    for (const path of [join(skills, 'ours'), join(skills, 'writing-agent-bios')]) {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    return commandOk(run(npm, ['rm', '-g', '@ours.network/codex']));
  }
  if (application === 'hermes') {
    const hermes = process.env.HERMES_DIR || join(home, '.hermes');
    stripBlock(join(hermes, 'config.yaml'), YAML_START, YAML_END);
    for (const path of [
      join(hermes, 'skills', 'communication', 'ours'),
      join(hermes, 'skills', 'communication', 'writing-agent-bios'),
    ]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    return commandOk(run(npm, ['rm', '-g', '@ours.network/hermes']));
  }
  return false;
}

function exactServiceEnv(profile) {
  return {
    OURS_CONFIG: profile.configPath,
    OURS_PORT: String(profile.port),
    OURS_STATE_DIR: profile.stateDir,
    ...(profile.serviceName ? { OURS_SERVICE_NAME: profile.serviceName } : {}),
  };
}

export function runNightlyUninstaller({ ttyFd, write, run, npm, assumeYes, finish }) {
  const home = process.env.HOME || homedir();
  const registryFile = profilesPath(process.env, home);
  let registry;
  try { registry = readRegistry(registryFile, { allowMissing: false }); }
  catch (error) { say(`Nightly profile registry is unavailable: ${error.message}`); finish(ttyFd); return; }
  let telegramConfig;
  let roomsConfig;
  try {
    telegramConfig = readObject(tgConfigPath(process.env, home));
    roomsConfig = readObject(coworkConfigPath(process.env, home));
  } catch (error) {
    say(`Refusing Nightly uninstall: ${error.message}`);
    finish(ttyFd); return;
  }
  line(heading('Nightly profile-aware uninstall'));
  const envHarnesses = process.env.OURS_UNINSTALL;
  let removeHarnesses;
  if (envHarnesses != null) removeHarnesses = canonHarnesses(envHarnesses).names;
  else if (ttyFd != null) removeHarnesses = checkboxSelect(write, ttyFd, [
    { name: 'claude-code', label: 'Claude Code plugin + its profile association' },
    { name: 'codex', label: 'Codex plugin + its profile association' },
    { name: 'hermes', label: 'Hermes plugin + its profile association' },
  ], { title: 'Choose harness plugins to remove' });
  else removeHarnesses = [];

  const ids = Object.keys(registry.profiles);
  let profileId = process.env.OURS_UNINSTALL_PROFILE || '';
  if (!profileId && ttyFd != null && ids.length) {
    line('  Profiles: ' + ids.map((id, index) => `${index + 1}) ${id}`).join(' · '));
    const choice = askLine(write, ttyFd, '  Profile to forget/remove (Enter keeps all): ', '');
    if (/^\d+$/.test(choice)) profileId = ids[Number(choice) - 1] || '';
    else profileId = choice;
  }
  const forgetProfile = !!profileId && (process.env.OURS_UNINSTALL_FORGET_PROFILE === 'yes' || (!assumeYes && ttyFd != null && askLine(write, ttyFd, `  Type 'forget ${profileId}' to remove metadata only: `, '') === `forget ${profileId}`));
  const removeDaemon = !!profileId && (process.env.OURS_UNINSTALL_DAEMON === 'yes' || (!assumeYes && ttyFd != null && askLine(write, ttyFd, `  Type 'remove ${profileId}' to remove its installer-owned service: `, '') === `remove ${profileId}`));
  let deleteData = false;
  if (removeDaemon && process.env.OURS_UNINSTALL_DATA === 'yes') deleteData = true;
  else if (removeDaemon && ttyFd != null) {
    const path = registry.profiles[profileId]?.stateDir;
    if (path) {
      line(c.red(`  Data deletion permanently destroys identities and private keys at ${path}.`));
      deleteData = askLine(write, ttyFd, `  Type the exact path ${path} to confirm key loss, or Enter to keep data: `, '') === path;
    }
  }

  const connectorActions = {};
  if (profileId && (forgetProfile || removeDaemon)) {
    const dependencies = reverseApplicationIndex(registry, { telegramConfig, roomsConfig })[profileId] || [];
    for (const connector of ['telegram', 'rooms']) {
      if (!dependencies.includes(connector)) continue;
      const envName = connector === 'telegram' ? 'OURS_UNINSTALL_TELEGRAM' : 'OURS_UNINSTALL_ROOMS';
      let raw = process.env[envName] || '';
      if (!raw && !assumeYes && ttyFd != null) {
        raw = askLine(
          write, ttyFd,
          `  ${connector} uses ${profileId}. Type detach, uninstall, or reassign:<retained-profile-id>: `,
          '',
        );
      }
      try {
        const parsed = parseConnectorLifecycle(raw, connector);
        if (parsed) connectorActions[connector] = parsed;
      } catch (error) {
        say(`Refusing Nightly uninstall: ${error.message}`); finish(ttyFd); return;
      }
    }
  }

  let plan;
  try {
    plan = planNightlyUninstall(registry, {
      removeHarnesses, profileId: profileId || undefined, forgetProfile, removeDaemon,
      deleteData, connectorActions,
    }, { telegramConfig, roomsConfig });
  } catch (error) { say(`Refusing uninstall plan: ${error.message}`); finish(ttyFd); return; }

  for (const application of removeHarnesses) {
    if (!removeHarnessArtifacts(application, { run, npm, home })) {
      say(`Could not remove ${application} artifacts; its registry association was left unchanged.`);
      finish(ttyFd); return;
    }
  }
  const connectorConfigs = { telegram: telegramConfig, rooms: roomsConfig };
  const appliedConnectors = [];
  for (const action of plan.actions) {
    if (action.type !== 'connector-lifecycle') continue;
    const result = applyConnectorLifecycle(action, connectorConfigs[action.connector], { home, run });
    if (!result.ok) {
      const recovered = rollbackConnectorLifecycles(appliedConnectors, run);
      say(`${result.error}; daemon/profile registry left unchanged.${recovered ? '' : ' Earlier connector rollback also failed; inspect those services.'}`);
      finish(ttyFd); return;
    }
    appliedConnectors.push({ ...result, action });
  }
  const removedServices = [];
  for (const action of plan.actions) {
    if (action.type === 'uninstall-service') {
      const result = run('ours-mcp', ['uninstall-service'], { env: exactServiceEnv(action.profile) });
      if (!commandOk(result)) {
        const recovered = rollbackConnectorLifecycles(appliedConnectors, run);
        say(`Could not uninstall the exact service for ${action.profileId}; registry left unchanged.${recovered ? '' : ' Connector rollback also failed; inspect those services.'}`);
        finish(ttyFd); return;
      }
      removedServices.push(action);
    }
    if (action.type === 'external-service-kept') say(`Profile ${action.profileId} is external; its service/config/state were left untouched.`);
  }
  try { writeRegistry(registryFile, plan.registry); }
  catch (error) {
    let recovered = true;
    for (const action of removedServices.reverse()) {
      const restored = commandOk(run('ours-mcp', ['install-service'], { env: exactServiceEnv(action.profile) }));
      recovered &&= restored;
    }
    const connectorsRecovered = rollbackConnectorLifecycles(appliedConnectors, run);
    recovered &&= connectorsRecovered;
    say(`Registry commit failed: ${error.message}. ${recovered ? 'Removed services/connectors were restored.' : 'Service recovery also failed; inspect the exact profile and connector services.'}`);
    finish(ttyFd); return;
  }
  for (const action of plan.actions) {
    if (action.type === 'delete-state') {
      if (existsSync(action.path)) rmSync(action.path, { recursive: true, force: true });
      say(`Permanently removed ${action.path}; identities/keys there are not recoverable.`);
    }
    if (action.type === 'forget-metadata') say(`Forgot external profile ${action.profileId}; no daemon artifacts were changed.`);
    if (action.type === 'connector-lifecycle' && action.mode === 'uninstall') {
      const runtime = connectorRuntime(action.connector, home);
      if (!commandOk(run(npm, ['rm', '-g', runtime.pkg]))) {
        say(`${action.connector} was safely detached, but its global package could not be removed.`);
      }
    }
  }
  if (plan.removeGlobalMcp && (removeDaemon || forgetProfile)) run(npm, ['rm', '-g', '@ours.network/mcp']);
  else say('Kept the global @ours.network/mcp package because retained profiles/applications still need it.');
  say('Nightly uninstall complete.');
  finish(ttyFd);
}
