import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { heading, c } from './ui.mjs';
import { askLine, checkboxSelect } from './prompt.mjs';
import { canonHarnesses, coworkConfigPath, tgConfigPath } from './logic.mjs';
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
  { removeHarnesses = [], profileId, forgetProfile = false, removeDaemon = false, deleteData = false } = {},
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
  const dependencies = profileId ? (index[profileId] || []) : [];
  if ((forgetProfile || removeDaemon) && dependencies.length) {
    throw new Error(`profile ${profileId} is still required by: ${dependencies.join(', ')}`);
  }
  if (deleteData && !removeDaemon) throw new Error('data deletion requires selecting daemon removal');
  if (forgetProfile && removeDaemon) throw new Error('choose either metadata-only forgetting or daemon removal, not both');
  if (deleteData && !profile?.ownership.state) throw new Error(`profile ${profileId} state is external; the installer will not delete it`);
  const actions = [];
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
  const retainedApplications = Object.values(remainingIndex).flat();
  const removeGlobalMcp = Object.keys(next.profiles).length === 0 && retainedApplications.length === 0;
  return { registry: next, removedAssociations, dependencies, actions, removeGlobalMcp };
}

const commandOk = (result) => result?.ok === true || result?.status === 0;

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

  let plan;
  try {
    plan = planNightlyUninstall(registry, { removeHarnesses, profileId: profileId || undefined, forgetProfile, removeDaemon, deleteData }, { telegramConfig, roomsConfig });
  } catch (error) { say(`Refusing uninstall plan: ${error.message}`); finish(ttyFd); return; }

  for (const application of removeHarnesses) {
    if (!removeHarnessArtifacts(application, { run, npm, home })) {
      say(`Could not remove ${application} artifacts; its registry association was left unchanged.`);
      finish(ttyFd); return;
    }
  }
  const removedServices = [];
  for (const action of plan.actions) {
    if (action.type === 'uninstall-service') {
      const result = run('ours-mcp', ['uninstall-service'], { env: exactServiceEnv(action.profile) });
      if (!commandOk(result)) { say(`Could not uninstall the exact service for ${action.profileId}; registry left unchanged.`); finish(ttyFd); return; }
      removedServices.push(action);
    }
    if (action.type === 'external-service-kept') say(`Profile ${action.profileId} is external; its service/config/state were left untouched.`);
  }
  try { writeRegistry(registryFile, plan.registry); }
  catch (error) {
    let recovered = true;
    for (const action of removedServices.reverse()) {
      recovered &&= commandOk(run('ours-mcp', ['install-service'], { env: exactServiceEnv(action.profile) }));
    }
    say(`Registry commit failed: ${error.message}. ${recovered ? 'Removed services were restored.' : 'Service recovery also failed; inspect the exact profile service.'}`);
    finish(ttyFd); return;
  }
  for (const action of plan.actions) {
    if (action.type === 'delete-state') {
      if (existsSync(action.path)) rmSync(action.path, { recursive: true, force: true });
      say(`Permanently removed ${action.path}; identities/keys there are not recoverable.`);
    }
    if (action.type === 'forget-metadata') say(`Forgot external profile ${action.profileId}; no daemon artifacts were changed.`);
  }
  if (plan.removeGlobalMcp && (removeDaemon || forgetProfile)) run(npm, ['rm', '-g', '@ours.network/mcp']);
  else say('Kept the global @ours.network/mcp package because retained profiles/applications still need it.');
  say('Nightly uninstall complete.');
  finish(ttyFd);
}
