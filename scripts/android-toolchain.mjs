import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function executablePath(path, platform = process.platform) {
  if (!path) return undefined;
  const candidates = platform === 'win32' ? [`${path}.exe`, `${path}.cmd`, `${path}.bat`, path] : [path];
  return candidates.find((candidate) => existsSync(candidate));
}

function commandOutput(value) {
  if (value === null || value === undefined) return '';
  return Buffer.isBuffer(value) ? value.toString() : String(value);
}

export function normalizeCommandResult(result) {
  const stdout = commandOutput(result.stdout);
  const stderr = commandOutput(result.stderr) || (result.error instanceof Error ? result.error.message : '');
  return {
    ...result,
    rawStdout: result.stdout,
    rawStderr: result.stderr,
    stdout,
    stderr,
  };
}

let cmdInvocation = 0;

function windowsBatchInvocation(executable, args, environment) {
  const values = [executable, ...args].map(String);
  if (values.some((value) => /\0|\r|\n/u.test(value))) throw new Error('Windows command arguments cannot contain NUL or line breaks.');
  const prefix = `ZOD_ANDROID_CMD_${process.pid}_${cmdInvocation += 1}`;
  const variables = values.map((value, index) => `${prefix}_${index}`);
  const childEnvironment = { ...environment };
  for (const [index, value] of values.entries()) {
    childEnvironment[variables[index]] = value;
  }
  const commandLine = `"${variables.map((name) => `"%${name}%"`).join(' ')}"`;
  return { commandLine, environment: childEnvironment };
}

export function runPlatformCommand(command, args = [], options = {}, platform = process.platform) {
  const executable = String(command);
  const environment = options.env ?? process.env;
  const batchFile = platform === 'win32' && /\.(?:bat|cmd)$/iu.test(executable);
  if (batchFile) {
    const invocation = windowsBatchInvocation(executable, args, environment);
    const spawnCommand = environment.ComSpec || process.env.ComSpec || 'cmd.exe';
    const spawnArguments = ['/d', '/s', '/c', invocation.commandLine];
    return normalizeCommandResult(spawnSync(spawnCommand, spawnArguments, { ...options, env: invocation.environment, windowsVerbatimArguments: true }));
  }
  return normalizeCommandResult(spawnSync(executable, args.map(String), options));
}

function workingJavaHome(path, platform = process.platform) {
  const java = executablePath(path && join(path, 'bin/java'), platform);
  return Boolean(java && runPlatformCommand(java, ['-version'], { stdio: 'ignore' }, platform).status === 0);
}

function javaInstallations(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .flatMap((path) => [join(path, 'Contents/Home'), path]);
  } catch {
    return [];
  }
}

export function discoverJavaHome(environment = process.env, platform = process.platform) {
  const macJava = platform === 'darwin'
    ? spawnSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' })
    : { status: 1, stdout: '' };
  const pathJava = platform === 'win32'
    ? undefined
    : spawnSync('sh', ['-c', 'command -v java'], { encoding: 'utf8' }).stdout?.trim();
  const candidates = [
    environment.JAVA_HOME?.trim(),
    macJava.status === 0 ? macJava.stdout.trim() : undefined,
    pathJava ? dirname(dirname(pathJava)) : undefined,
    platform === 'win32' ? 'C:/Program Files/Android/Android Studio/jbr' : undefined,
    ...javaInstallations(join(homedir(), 'Library/Java/JavaVirtualMachines')),
    ...javaInstallations(join(homedir(), 'Developer/kai-cloud-toolchains')),
  ];
  return candidates.find((candidate) => workingJavaHome(candidate, platform));
}

function workingAndroidHome(path, platform = process.platform) {
  return Boolean(executablePath(path && join(path, 'platform-tools/adb'), platform)
    && executablePath(path && join(path, 'build-tools/36.0.0/aapt2'), platform));
}

export function discoverAndroidHome(environment = process.env, platform = process.platform) {
  return [
    environment.ANDROID_HOME?.trim(),
    environment.ANDROID_SDK_ROOT?.trim(),
    platform === 'win32' ? join(homedir(), 'AppData/Local/Android/Sdk') : undefined,
    join(homedir(), 'Library/Android/sdk'),
    join(homedir(), 'Android/Sdk'),
    join(homedir(), 'Developer/kai-cloud-toolchains/android-sdk'),
  ].find((candidate) => workingAndroidHome(candidate, platform));
}

export function androidToolchainEnvironment(environment = process.env) {
  const javaHome = discoverJavaHome(environment);
  const androidHome = discoverAndroidHome(environment);
  return {
    ...environment,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    ...(androidHome ? { ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome } : {}),
  };
}

export function platformExecutable(home, relativePath, platform = process.platform) {
  const unresolved = home ? join(home, relativePath) : relativePath;
  return executablePath(unresolved, platform) ?? unresolved;
}

export function runGradle(root, args, options = {}, platform = process.platform) {
  const androidRoot = resolve(root, 'android');
  const wrapper = join(androidRoot, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) {
    return {
      status: 1,
      stdout: '',
      stderr: `Android Gradle wrapper not found at ${wrapper}. Run npm run prebuild:android first.`,
    };
  }
  return runPlatformCommand(wrapper, args, {
    cwd: androidRoot,
    ...options,
  }, platform);
}
