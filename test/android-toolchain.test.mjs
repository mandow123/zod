import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverAndroidHome, platformExecutable, runGradle, runPlatformCommand } from '../scripts/android-toolchain.mjs';

test('Windows Android tools resolve their executable suffixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'zod-android-sdk-'));
  try {
    const adb = join(root, 'platform-tools', 'adb.exe');
    const aapt2 = join(root, 'build-tools', '36.0.0', 'aapt2.exe');
    mkdirSync(join(root, 'platform-tools'), { recursive: true });
    mkdirSync(join(root, 'build-tools', '36.0.0'), { recursive: true });
    writeFileSync(adb, '');
    writeFileSync(aapt2, '');
    assert.equal(discoverAndroidHome({ ANDROID_HOME: root }, 'win32'), root);
    assert.equal(platformExecutable(root, 'platform-tools/adb', 'win32'), adb);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gradle arguments run through a wrapper in a metacharacter path', () => {
  const root = mkdtempSync(join(tmpdir(), 'zod & gradle-wrapper-'));
  try {
    const androidRoot = join(root, 'android');
    mkdirSync(androidRoot, { recursive: true });
    const wrapper = join(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const script = process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" -e "process.stdout.write(process.argv.slice(1).join('|'))" %*\r\n`
      : '#!/bin/sh\nprintf "%s" "$*"\n';
    writeFileSync(wrapper, script);
    if (process.platform !== 'win32') chmodSync(wrapper, 0o755);
    const args = ['assembleDirectCnDebug', '-Plabel=A&B'];
    const result = runGradle(root, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(args.every((argument) => result.stdout.includes(argument)), result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package scripts avoid shell-specific Gradle and channel syntax', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['build:preview'], 'node scripts/run-android-gradle.mjs assembleDirectCnDebug');
  assert.match(packageJson.scripts['build:apk:direct'], /--channel=direct-cn/u);
  assert.match(packageJson.scripts['build:aab:play'], /--channel=google-play/u);
  for (const script of ['build:preview', 'build:apk:direct', 'build:aab:play']) {
    assert.doesNotMatch(packageJson.scripts[script], /\.\/gradlew|^[A-Z_]+=\S+/u);
  }
});

test('direct executables do not require a command shell', () => {
  const result = runPlatformCommand(process.execPath, ['-e', 'process.stdout.write("direct")'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'direct');
});

test('startup failures retain their error and normalize text output', () => {
  const missing = join(tmpdir(), `zod-missing-${process.pid}-${Date.now()}.exe`);
  const result = runPlatformCommand(missing, [], { encoding: 'utf8' });
  assert.equal(result.status, null);
  assert.ok(result.error instanceof Error);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  assert.match(result.stderr, /ENOENT|not found|cannot find/iu);
});

test('Windows cmd wrappers preserve metacharacter arguments', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'zod & cmd-wrapper-'));
  try {
    const wrapper = join(root, 'echo args.cmd');
    writeFileSync(
      wrapper,
      `@echo off\r\n"${process.execPath}" -e "process.stdout.write(process.argv[1])" %*\r\n`,
    );
    const argument = 'value & (safe) ^ < > | 100% !';
    const result = runPlatformCommand(wrapper, [argument], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, argument);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows apksigner.bat resolves and launches through cmd.exe', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'zod & android-sdk-'));
  try {
    const buildTools = join(root, 'build-tools', '36.0.0');
    mkdirSync(buildTools, { recursive: true });
    const batch = join(buildTools, 'apksigner.bat');
    writeFileSync(
      batch,
      `@echo off\r\n"${process.execPath}" -e "process.stdout.write(process.argv[1])" %*\r\n`,
    );
    const resolved = platformExecutable(root, 'build-tools/36.0.0/apksigner', 'win32');
    assert.equal(resolved, batch);
    const result = runPlatformCommand(resolved, ['verify'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'verify');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
