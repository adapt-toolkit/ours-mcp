// ours-install v3 — the config journal.
//
// WHAT THIS IS FOR, IN ONE SENTENCE: v3 could write a config file describing a
// daemon it then failed to bring up, print one warning line, and go on to say
// "install complete".
//
// The nightly installer does not have that failure. It snapshots every config
// file before touching it and restores the bytes when the plan does not complete
// (lib/nightly-install.mjs `snap`/`rollbackSnapshots`), and it says precisely what
// it could NOT undo. This is that behaviour, carried into v3's shape rather than
// copied into it.
//
// THE LINE THIS DOES NOT CROSS. Package and plugin installs are NOT rolled back.
// Not because it is hard, but because it is wrong: npm cannot be un-run
// meaningfully, a newer package is not damage, and nightly draws the line in the
// same place and says so. What gets restored is exactly the bytes of files this
// installer rewrote. Everything else is REPORTED.
//
// SCOPE IS PER UNIT OF WORK, NOT PER RUN, and that is the one design decision
// here worth reading twice. v3's rule is that a failed extra never undoes a
// daemon that came up correctly (lib/orchestrate.mjs `attempt`), so a single
// run-wide journal restored at the end would fight the architecture: a cowork
// failure would roll back the daemon's own config. Instead each journal covers
// ONE write and the step that makes its bytes true — write the connector config,
// then install its service; if the service does not come up, the config goes
// back. The pairing is the whole idea, and it is why `snapshot` and `restoreAll`
// are on an object you hold for the length of one unit of work rather than
// functions you call anywhere.

import { ok, info, warn } from './ui.mjs';

/**
 * A journal for one unit of work.
 *
 * `effects.snapshot(path)` and `effects.restore(path, snapshot)` are the seam, so
 * this is testable without a filesystem for the same reason everything else here
 * is. On a dry run nothing was written, so nothing is snapshotted and nothing can
 * be restored — the journal is inert rather than special-cased at each call site.
 */
export function configJournal(effects, { dryRun = false } = {}) {
  const entries = [];
  return {
    get entries() { return entries.slice(); },

    /**
     * Record the current bytes of `path` BEFORE it is written. Idempotent per
     * path: the FIRST snapshot is the one that survives, because that is the
     * state the run started from. Snapshotting twice and keeping the second would
     * "restore" to a value this run itself wrote.
     */
    snapshot(path) {
      if (dryRun) return null;
      if (entries.some((e) => e.path === path)) return entries.find((e) => e.path === path).snapshot;
      const snapshot = effects.snapshot(path);
      entries.push({ path, snapshot });
      return snapshot;
    },

    /**
     * Put every journalled file back, most recent first.
     *
     * A restore that itself fails is reported, never thrown: the caller is already
     * on a failure path, and losing the original error to a second one would hide
     * the thing that actually went wrong. The report says which files went back
     * and which did not, so a partially recovered state is visible rather than
     * implied.
     */
    restoreAll() {
      const restored = [];
      const failed = [];
      for (const entry of entries.slice().reverse()) {
        try {
          effects.restore(entry.path, entry.snapshot);
          restored.push({ path: entry.path, existed: entry.snapshot?.exists !== false });
        } catch (error) {
          failed.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      entries.length = 0;
      return { restored, failed };
    },
  };
}

/**
 * The report, and it is half the feature.
 *
 * A rollback nobody is told about is indistinguishable from a run that did
 * nothing. Three separate facts, each stated plainly:
 *
 *   · which files were put back, and whether "back" meant deleting one this run
 *     created — because "restored" and "removed the file we made" are different
 *     things to read on a screen;
 *   · which could not be put back, if any;
 *   · that completed package installs were NOT rolled back. This last line is the
 *     honest boundary, and it is nightly's wording rather than a new one.
 */
export function reportRollback(effects, outcome, { packagesInstalled = false } = {}) {
  const { restored = [], failed = [] } = outcome ?? {};
  if (restored.length === 0 && failed.length === 0) return false;
  for (const item of restored) {
    effects.out(item.existed
      ? ok(`rolled back ${item.path} to its previous contents`)
      : ok(`removed ${item.path} — this run created it and did not finish`));
  }
  for (const item of failed) {
    effects.out(warn(`could NOT roll back ${item.path}: ${item.reason} — inspect it before re-running`));
  }
  if (packagesInstalled) {
    effects.out(info('completed package installs were not rolled back — a newer package is not damage, and npm cannot be un-run'));
  }
  return true;
}
