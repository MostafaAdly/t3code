/**
 * Builds the desktop app from this checkout and replaces the installed copy
 * with it, then relaunches.
 *
 *   vp run reinstall            build, swap, relaunch (detached)
 *   vp run reinstall --attach   run in the foreground
 *
 * Detached by default because the installed app is usually the one you are
 * running this from: quitting it would otherwise kill the build mid-flight.
 * Progress goes to <t3 home>/reinstall.log.
 *
 * macOS only. Other platforms build artifacts with the `dist:desktop:*`
 * scripts but install them through their own package managers.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptPath = NodeURL.fileURLToPath(import.meta.url);
const repoRoot = NodePath.join(NodePath.dirname(scriptPath), "..");
const logPath = NodePath.join(
  process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3"),
  "reinstall.log",
);
const flags = process.argv.slice(2);
const attach = flags.includes("--attach");

// An unrecognized flag must never fall through to a real rebuild: this
// script quits and replaces the installed app.
const UNKNOWN = flags.filter((flag) => flag !== "--attach" && flag !== "--force");
if (UNKNOWN.length > 0) {
  console.log(
    [
      "Rebuild the desktop app from this checkout and replace the installed copy.",
      "",
      "  vp run reinstall            build, swap, relaunch (detached)",
      "  vp run reinstall --attach   run in the foreground",
      "  vp run reinstall --force    proceed even if a dev stack is running",
    ].join("\n"),
  );
  process.exit(UNKNOWN.some((flag) => flag === "--help" || flag === "-h") ? 0 : 1);
}

// Capability check rather than a platform name: this script installs by
// mounting a .dmg, so hdiutil is precisely what it needs.
if (NodeChildProcess.spawnSync("hdiutil", ["help"], { stdio: "ignore" }).status === null) {
  console.error(
    "reinstall installs a macOS .app bundle from a .dmg and needs hdiutil. On this platform build with `vp run dist:desktop:linux` or `dist:desktop:win` and install that artifact.",
  );
  process.exit(1);
}

/**
 * Pids whose command line contains `needle`, matched as a literal string.
 *
 * Deliberately not `pgrep -f`: its pattern is a regular expression, so the
 * parentheses in "Adly (Alpha).app" are read as a group and the path can
 * never match. That silently reported "nothing is running" and let the
 * bundle be deleted out from under a live app.
 */
const pidsMatching = (needle: string): Array<string> =>
  (NodeChildProcess.spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(needle))
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((pid) => pid.length > 0);

/** Working directory per pid, for the pids lsof can see. */
const cwdByPid = (pids: ReadonlyArray<string>): Map<string, string> => {
  const result = new Map<string, string>();
  if (pids.length === 0) return result;
  const out =
    NodeChildProcess.spawnSync("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], {
      encoding: "utf8",
    }).stdout ?? "";
  let pid = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid.length > 0) result.set(pid, line.slice(1));
  }
  return result;
};

const isInsideRepo = (cwd: string | undefined) =>
  cwd !== undefined && (cwd === repoRoot || cwd.startsWith(repoRoot + NodePath.sep));

// A dev stack from this checkout fights the installed app for loopback ports,
// and the desktop dev watcher (`vp pack --watch` driving dev-electron.mjs)
// relaunches Electron every time the artifact build below rewrites
// dist-electron/ or apps/server/dist/. Those watchers outlive their dev-runner
// whenever the terminal that ran `vp run dev:desktop` dies with the app, so
// they are matched directly: each survivor opens one more window whose backend
// can never take its port. Refusing here is cheaper than diagnosing that.
if (!flags.includes("--force")) {
  const runners = pidsMatching("scripts/dev-runner.ts").filter(
    (pid) => pid !== String(process.pid),
  );
  const watcherCandidates = [...pidsMatching("dev-electron.mjs"), ...pidsMatching("pack --watch")];
  const cwds = cwdByPid(watcherCandidates);
  const watchers = watcherCandidates.filter((pid) => isInsideRepo(cwds.get(pid)));
  const pids = [...new Set([...runners, ...watchers])];
  if (pids.length > 0) {
    console.error(
      [
        `A dev stack from this checkout is running (pid ${pids.join(", ")}).`,
        "Its desktop watcher relaunches Electron whenever the build rewrites dist-electron/,",
        "so reinstalling now opens extra windows whose backend can never bind its port.",
        "",
        `Stop it first (Ctrl+C in its terminal, or: kill ${pids.join(" ")}), then run this again.`,
        "Use --force to reinstall anyway.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// Re-exec detached so the build survives the app being quit below.
if (!attach && process.env.T3CODE_REINSTALL_CHILD !== "1") {
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
  const log = NodeFS.openSync(logPath, "a");
  NodeChildProcess.spawn(process.execPath, [scriptPath, "--attach", "--force"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, T3CODE_REINSTALL_CHILD: "1" },
  }).unref();
  console.log(`Rebuilding in the background. Follow along with:\n  tail -f ${logPath}`);
  console.log("The app quits and relaunches on its own when the build finishes.");
  process.exit(0);
}

const step = (message: string) => console.log(`=== ${new Date().toISOString()} ${message}`);

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly quiet?: boolean },
) =>
  NodeChildProcess.spawnSync(command, [...args], {
    cwd: repoRoot,
    stdio: options?.quiet ? "ignore" : "inherit",
    encoding: "utf8",
  });

step("building");
// No --arch: build-desktop-artifact already defaults to this machine's.
const build = run("node", [
  NodePath.join(repoRoot, "scripts", "build-desktop-artifact.ts"),
  "--platform",
  "mac",
  "--target",
  "dmg",
]);
if (build.status !== 0) {
  step("build failed; the installed app was left untouched");
  process.exit(1);
}

const releaseDir = NodePath.join(repoRoot, "release");
const dmg = NodeFS.existsSync(releaseDir)
  ? NodeFS.readdirSync(releaseDir)
      .filter((name) => name.endsWith(".dmg"))
      .map((name) => NodePath.join(releaseDir, name))
      .sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)
      .find(() => true)
  : undefined;
if (!dmg) {
  step("no .dmg in release/; the installed app was left untouched");
  process.exit(1);
}

step(`mounting ${dmg}`);
const mount = NodeChildProcess.spawnSync("hdiutil", ["attach", "-nobrowse", "-readonly", dmg], {
  encoding: "utf8",
});
const volume = mount.stdout
  ?.split("\n")
  .map((line) => line.split("\t").at(-1)?.trim())
  .findLast((value): value is string => Boolean(value?.startsWith("/Volumes/")));
const appName = volume
  ? NodeFS.readdirSync(volume).find((name) => name.endsWith(".app"))
  : undefined;
if (!volume || !appName) {
  step("could not mount the disk image; the installed app was left untouched");
  process.exit(1);
}
const source = NodePath.join(volume, appName);
const target = NodePath.join("/Applications", appName);
const detach = () => run("hdiutil", ["detach", volume, "-quiet"], { quiet: true });

const displayName = appName.replace(/\.app$/, "");
const runningPids = () => pidsMatching(`${target}/Contents/MacOS/`);

step(`quitting ${displayName}`);
run("osascript", ["-e", `quit app "${displayName}"`], { quiet: true });
for (let attempt = 0; attempt < 40 && runningPids().length > 0; attempt++) {
  NodeChildProcess.spawnSync("sleep", ["1"]);
}

// Replacing the bundle under a live process leaves a window whose resources
// have been deleted: it renders black and never recovers. Stop instead.
const stubborn = runningPids();
if (stubborn.length > 0) {
  detach();
  step(`${displayName} is still running (pid ${stubborn.join(", ")}); nothing was replaced`);
  console.error(
    `Quit ${displayName} and run this again, or stop it with: kill ${stubborn.join(" ")}`,
  );
  process.exit(1);
}

step(`replacing ${target}`);
run("rm", ["-rf", target], { quiet: true });
const copy = run("ditto", [source, target]);
detach();
if (copy.status !== 0) {
  step("copy failed; reinstall the app manually from release/");
  process.exit(1);
}
// Fresh bundles from a local build carry the quarantine flag; clear it so the
// app opens without a Gatekeeper prompt.
run("xattr", ["-dr", "com.apple.quarantine", target], { quiet: true });

step("relaunching");
run("open", ["-a", target], { quiet: true });
step("done");
