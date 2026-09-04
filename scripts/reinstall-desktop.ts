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

// A dev stack from this checkout and the installed app fight over the same
// loopback ports, and a crash-looping backend leaves windows that can never
// authenticate. Refusing here is cheaper than diagnosing that afterwards.
if (!flags.includes("--force")) {
  const running = NodeChildProcess.spawnSync("pgrep", ["-f", "scripts/dev-runner.ts"], {
    encoding: "utf8",
  });
  const pids = (running.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== String(process.pid));
  if (pids.length > 0) {
    console.error(
      [
        `A dev stack is running (pid ${pids.join(", ")}). It shares this machine's dev ports,`,
        "so reinstalling now can leave app windows that never finish signing in.",
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

step(`quitting ${appName.replace(/\.app$/, "")}`);
run("osascript", ["-e", `quit app "${appName.replace(/\.app$/, "")}"`], { quiet: true });
for (let attempt = 0; attempt < 40; attempt++) {
  const running = NodeChildProcess.spawnSync("pgrep", ["-f", `${target}/Contents/MacOS/`], {
    encoding: "utf8",
  });
  if (running.status !== 0) break;
  NodeChildProcess.spawnSync("sleep", ["1"]);
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
