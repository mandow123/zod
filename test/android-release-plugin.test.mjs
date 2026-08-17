import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { insertSigningConfig } = require('../plugins/with-android-release-signing.js');

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
  assert.match(once, /signingConfig signingConfigs\.release/u);
  assert.equal(twice, once);
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
