import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LocateEnv = {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
};

/**
 * Every place adb could be, in the order we try them:
 * $ADB, then PATH, then $ANDROID_HOME / $ANDROID_SDK_ROOT, then the default
 * Android Studio SDK folder for the OS, then common package-manager paths.
 */
export function adbCandidates({ env, platform, home }: LocateEnv): string[] {
  const win = platform === 'win32';
  const exe = win ? 'adb.exe' : 'adb';
  const join = win ? path.win32.join : path.posix.join;
  const out: string[] = [];
  if (env.ADB) out.push(env.ADB);
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(win ? ';' : ':')) if (dir) out.push(join(dir, exe));
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_SDK']) {
    const sdk = env[key];
    if (sdk) out.push(join(sdk, 'platform-tools', exe));
  }
  if (platform === 'darwin') {
    out.push(join(home, 'Library/Android/sdk/platform-tools', exe));
    out.push('/opt/homebrew/bin/adb', '/usr/local/bin/adb');
  } else if (win) {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    out.push(join(local, 'Android', 'Sdk', 'platform-tools', exe));
    out.push('C:\\platform-tools\\adb.exe', 'C:\\Android\\platform-tools\\adb.exe');
  } else {
    out.push(join(home, 'Android/Sdk/platform-tools', exe));
    out.push('/usr/bin/adb', '/usr/local/bin/adb', '/opt/android-sdk/platform-tools/adb', '/usr/lib/android-sdk/platform-tools/adb');
  }
  return [...new Set(out)];
}

function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first adb binary that exists, or null. */
export function findAdb(envOverride?: Partial<LocateEnv>, exists: (file: string) => boolean = isExecutable): string | null {
  const le: LocateEnv = {
    env: envOverride?.env ?? process.env,
    platform: envOverride?.platform ?? process.platform,
    home: envOverride?.home ?? os.homedir(),
  };
  for (const c of adbCandidates(le)) if (exists(c)) return c;
  return null;
}

export const ADB_INSTALL_HINT =
  'Install Android platform-tools (https://developer.android.com/tools/releases/platform-tools), ' +
  'e.g. `brew install --cask android-platform-tools` on macOS or `sudo apt install adb` on Debian/Ubuntu, ' +
  'or point FireLab at it with the ADB environment variable';
