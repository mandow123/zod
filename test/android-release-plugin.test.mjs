import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  insertSigningConfig, stagingSourceFiles, writeStagingSourceSet,
} = require('../plugins/with-android-release-signing.js');

const generatedGradle = `android {
    defaultConfig {
        applicationId 'com.kaicloud.marketplace'
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
        }
    }
}`;

test('Android prebuild always restores signed direct and store release variants', () => {
  const once = insertSigningConfig(generatedGradle);
  const twice = insertSigningConfig(once);

  assert.match(once, /KAI_CLOUDPAY_DISTRIBUTION_FLAVORS/u);
  assert.match(once, /flavorDimensions \+= "distribution"/u);
  assert.match(once, /directCn \{/u);
  assert.match(once, /store \{/u);
  assert.match(once, /staging \{/u);
  assert.match(once, /applicationIdSuffix "\.staging"/u);
  assert.match(once, /resValue "string", "app_name", "Zod 测试版"/u);
  assert.doesNotMatch(once, /Zod 演示版/u);
  assert.match(once, /signingConfig signingConfigs\.release/u);
  assert.equal(twice, once);
});

test('staging prebuild never creates a duplicated staging application ID', () => {
  const once = insertSigningConfig(generatedGradle.replace(
    "applicationId 'com.kaicloud.marketplace'", "applicationId 'com.kaicloud.marketplace.staging'",
  ));
  assert.match(once, /resValue "string", "app_name", "Zod 测试版"/u);
  assert.doesNotMatch(once, /applicationIdSuffix "\.staging"/u);
  assert.doesNotMatch(once, /\.staging\.staging/u);
});

test('Android manifest allows cleartext only for an explicit local E2E build', () => {
  const pluginSource = require('node:fs').readFileSync(
    new URL('../plugins/with-android-release-signing.js', import.meta.url), 'utf8',
  );
  assert.match(pluginSource, /withAndroidManifest/u);
  assert.match(pluginSource, /CLOUDPAY_LOCAL_E2E_BASE_URL/u);
  assert.match(pluginSource, /android:usesCleartextTraffic/u);
  assert.match(pluginSource, /delete application\.\$\['android:usesCleartextTraffic'\]/u);
});

test('formal prebuild regenerates an isolated staging source set without orange assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zod-android-plugin-'));
  try {
    await writeStagingSourceSet(root);
    const generated = await Promise.all(Object.keys(stagingSourceFiles).map(async (relativePath) => [
      relativePath, await readFile(join(root, relativePath), 'utf8'),
    ]));
    const files = Object.fromEntries(generated);
    assert.match(files['app/src/staging/AndroidManifest.xml'],
      /android:networkSecurityConfig="@xml\/zod_staging_network_security_config"/u);
    assert.doesNotMatch(files['app/src/staging/AndroidManifest.xml'], /usesCleartextTraffic="true"/u);
    assert.match(files['app/src/staging/res/xml/zod_staging_network_security_config.xml'],
      /<domain includeSubdomains="false">10\.0\.2\.2<\/domain>/u);
    assert.match(files['app/src/staging/res/xml/zod_staging_network_security_config.xml'],
      /<base-config cleartextTrafficPermitted="false"/u);
    assert.match(files['app/src/staging/res/drawable/zod_staging_icon_foreground.xml'], /#1677FF/u);
    assert.match(files['app/src/staging/res/drawable/zod_staging_icon_foreground.xml'], /#16A34A/u);
    assert.doesNotMatch(Object.values(files).join('\n'),
      /#(?:E87909|FF6A00|FFF4E5|FFF0E5)|DEMO|演示/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
