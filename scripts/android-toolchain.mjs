import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function executable(path) {
  return Boolean(path && existsSync(path));
}

function workingJavaHome(path) {
  if (!executable(path && join(path, 'bin/java'))) return false;
  return spawnSync(join(path, 'bin/java'), ['-version'], { stdio: 'ignore' }).status === 0;
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

export function discoverJavaHome(environment = process.env) {
  const macJava = spawnSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' });
  const pathJava = spawnSync('sh', ['-c', 'command -v java'], { encoding: 'utf8' }).stdout?.trim();
  const candidates = [
    environment.JAVA_HOME?.trim(),
    macJava.status === 0 ? macJava.stdout.trim() : undefined,
    pathJava ? dirname(dirname(pathJava)) : undefined,
    ...javaInstallations(join(homedir(), 'Library/Java/JavaVirtualMachines')),
    ...javaInstallations(join(homedir(), 'Developer/kai-cloud-toolchains')),
  ];
  return candidates.find(workingJavaHome);
}

function workingAndroidHome(path) {
  return executable(path && join(path, 'platform-tools/adb'))
    && executable(path && join(path, 'build-tools/36.0.0/aapt2'));
}

export function discoverAndroidHome(environment = process.env) {
  return [
    environment.ANDROID_HOME?.trim(),
    environment.ANDROID_SDK_ROOT?.trim(),
    join(homedir(), 'Library/Android/sdk'),
    join(homedir(), 'Android/Sdk'),
    join(homedir(), 'Developer/kai-cloud-toolchains/android-sdk'),
  ].find(workingAndroidHome);
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
