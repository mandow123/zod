const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const {
  AndroidConfig, withAndroidManifest, withAppBuildGradle, withDangerousMod,
} = require('expo/config-plugins');

const marker = '// KAI_CLOUDPAY_RELEASE_SIGNING';
const flavorsMarker = '// KAI_CLOUDPAY_DISTRIBUTION_FLAVORS';
const referralPlaceholdersMarker = '// KAI_CLOUDPAY_REFERRAL_MANIFEST_PLACEHOLDER';
const stagingSourceFiles = Object.freeze({
  'app/src/staging/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:networkSecurityConfig="@xml/zod_staging_network_security_config" />
</manifest>
`,
  'app/src/staging/res/xml/zod_staging_network_security_config.xml': `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>
`,
  'app/src/staging/res/drawable/zod_staging_icon_foreground.xml': `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
  <path android:fillColor="#FFFFFF" android:pathData="M24,18 C18,18 14,22 14,28 L14,80 C14,86 18,90 24,90 L84,90 C90,90 94,86 94,80 L94,28 C94,22 90,18 84,18 Z" />
  <path android:fillColor="#1677FF" android:pathData="M31,34 L77,34 L77,44 L49,68 L78,68 L78,78 L30,78 L30,68 L58,44 L31,44 Z" />
  <path android:fillColor="#16A34A" android:pathData="M82,20 C77,20 73,24 73,29 C73,34 77,38 82,38 C87,38 91,34 91,29 C91,24 87,20 82,20 Z" />
</vector>
`,
  'app/src/staging/res/mipmap-anydpi-v26/ic_launcher.xml': `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/iconBackground" />
  <foreground android:drawable="@drawable/zod_staging_icon_foreground" />
</adaptive-icon>
`,
  'app/src/staging/res/mipmap-anydpi-v26/ic_launcher_round.xml': `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/iconBackground" />
  <foreground android:drawable="@drawable/zod_staging_icon_foreground" />
</adaptive-icon>
`,
});
const block = `${marker}
def cloudPaySigningFile = rootProject.file('../release-signing.properties')
def cloudPaySigning = new Properties()
if (cloudPaySigningFile.exists()) {
    cloudPaySigningFile.withInputStream { cloudPaySigning.load(it) }
}
def cloudPayEnv = System.getenv()
def cloudPayStagingRequested = gradle.startParameter.taskNames.any {
    it.toLowerCase().contains('staging')
}
def cloudPayStagingEnabled = cloudPayEnv['CLOUDPAY_STAGING_DEMO'] == '1'
if (cloudPayStagingRequested != cloudPayStagingEnabled) {
    throw new GradleException('The staging flavor requires CLOUDPAY_STAGING_DEMO=1 and formal flavors forbid it.')
}
def cloudPayValue = { String propertyName, String environmentName ->
    def environmentValue = cloudPayEnv[environmentName]
    environmentValue != null && !environmentValue.trim().isEmpty()
        ? environmentValue.trim()
        : cloudPaySigning.getProperty(propertyName)
}
def cloudPayReleaseRequested = gradle.startParameter.taskNames.any {
    it.toLowerCase().contains('release') && !it.toLowerCase().contains('unittest')
}
def cloudPayStoreFile = cloudPayValue('storeFile', 'CLOUDPAY_UPLOAD_STORE_FILE')
def cloudPayStorePassword = cloudPayValue('storePassword', 'CLOUDPAY_UPLOAD_STORE_PASSWORD')
def cloudPayKeyAlias = cloudPayValue('keyAlias', 'CLOUDPAY_UPLOAD_KEY_ALIAS')
def cloudPayKeyPassword = cloudPayValue('keyPassword', 'CLOUDPAY_UPLOAD_KEY_PASSWORD')
def cloudPayHasEasCredentials = rootProject.file('../credentials.json').exists()
def cloudPayHasReleaseSigning = [cloudPayStoreFile, cloudPayStorePassword, cloudPayKeyAlias, cloudPayKeyPassword].every {
    it != null && !it.trim().isEmpty()
}
if (cloudPayReleaseRequested && !cloudPayHasReleaseSigning && !cloudPayHasEasCredentials) {
    throw new GradleException('CloudPay release signing is required. Configure release-signing.properties or CLOUDPAY_UPLOAD_* environment variables. Debug certificates are forbidden for release artifacts.')
}
`;

function insertSigningConfig(contents) {
  const anchor = 'android {';
  if (!contents.includes(anchor)) throw new Error('Unable to locate Android configuration.');
  let next = contents.includes(marker) ? contents : `${block}\n${contents}`;
  const debugConfig = `        debug {\n            storeFile file('debug.keystore')\n            storePassword 'android'\n            keyAlias 'androiddebugkey'\n            keyPassword 'android'\n        }`;
  const releaseConfig = `${debugConfig}\n        release {\n            if (cloudPayHasReleaseSigning) {\n                storeFile file(cloudPayStoreFile)\n                storePassword cloudPayStorePassword\n                keyAlias cloudPayKeyAlias\n                keyPassword cloudPayKeyPassword\n                enableV1Signing false\n                enableV2Signing true\n                enableV3Signing true\n                enableV4Signing true\n            }\n        }`;
  const formalPlaceholders = `${referralPlaceholdersMarker}\n        manifestPlaceholders = [\n            cloudPayReferralScheme: "kaicloudpay"\n        ]`;
  if (next.includes(referralPlaceholdersMarker)) {
    next = next.replace(
      new RegExp(`${referralPlaceholdersMarker}\\n\\s*manifestPlaceholders = \\[\\n[\\s\\S]*?\\n\\s*\\]`, 'u'),
      formalPlaceholders,
    );
  }
  next = next.replace(
    /\/\/ KAI_CLOUDPAY_AUTH_MANIFEST_PLACEHOLDERS\n\s*manifestPlaceholders = \[\n[\s\S]*?\n\s*\]/u,
    formalPlaceholders,
  );
  next = next.replace(
    /manifestPlaceholders = \[\n\s*cloudPayCustomScheme: "zod-staging",\n\s*cloudPayAuthHost: "zod-staging\.invalid",\n\s*cloudPayAuthPath: "\/disabled"\n\s*\]/u,
    'manifestPlaceholders = [\n                cloudPayReferralScheme: "zod-staging"\n            ]',
  );
  next = next.replace(
    /manifestPlaceholders = \[\n\s*cloudPayCustomScheme: "zod-staging\.invalid",\n\s*cloudPayAuthPath: "\/disabled"\n\s*\]/u,
    'manifestPlaceholders = [\n                cloudPayReferralScheme: "zod-staging"\n            ]',
  );
  if (!contents.includes(marker)) {
    if (!next.includes(debugConfig)) throw new Error('Unable to locate generated debug signing config.');
    next = next.replace(debugConfig, releaseConfig);
    next = next.replace(
      /release \{\n\s*\/\/ Caution![\s\S]*?signingConfig signingConfigs\.debug/u,
      `release {\n            signingConfig signingConfigs.release`,
    );
  }
  if (!next.includes(referralPlaceholdersMarker)) {
    const defaultConfigAnchor = '    defaultConfig {';
    if (!next.includes(defaultConfigAnchor)) throw new Error('Unable to locate Android default configuration.');
    next = next.replace(defaultConfigAnchor, `${defaultConfigAnchor}\n        ${formalPlaceholders}`);
  }
  const signingAnchor = '    signingConfigs {';
  if (!next.includes(flavorsMarker)) {
    if (!next.includes(signingAnchor)) throw new Error('Unable to locate Android signing configuration.');
    const generatedApplicationId = next.match(/applicationId\s+['"]([^'"]+)['"]/u)?.[1];
    if (!generatedApplicationId) throw new Error('Unable to locate generated Android application ID.');
    const stagingSuffix = generatedApplicationId.endsWith('.staging') ? '' : '\n            applicationIdSuffix ".staging"';
    const flavors = `${flavorsMarker}\n    flavorDimensions += "distribution"\n    productFlavors {\n        directCn {\n            dimension "distribution"\n        }\n        store {\n            dimension "distribution"\n        }\n        staging {\n            dimension "distribution"${stagingSuffix}\n            resValue "string", "app_name", "Zod 测试版"\n            manifestPlaceholders = [\n                cloudPayReferralScheme: "zod-staging"\n            ]\n        }\n    }\n`;
    next = next.replace(signingAnchor, `${flavors}\n${signingAnchor}`);
  }
  return next;
}

function pinReferralManifest(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  for (const activity of application.activity ?? []) {
    for (const filter of activity['intent-filter'] ?? []) {
      for (const data of filter.data ?? []) {
        if (data.$?.['android:scheme'] === 'kaicloudpay' && !data.$?.['android:path']) {
          data.$['android:scheme'] = '${cloudPayReferralScheme}';
        }
      }
    }
  }
  return manifest;
}

async function writeStagingSourceSet(platformProjectRoot) {
  await Promise.all(Object.entries(stagingSourceFiles).map(async ([relativePath, contents]) => {
    const target = path.join(platformProjectRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }));
}

module.exports = function withAndroidReleaseSigning(config) {
  const withSigning = withAppBuildGradle(config, (gradle) => {
    gradle.modResults.contents = insertSigningConfig(gradle.modResults.contents);
    return gradle;
  });
  const withManifest = withAndroidManifest(withSigning, (manifest) => {
    pinReferralManifest(manifest.modResults);
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest.modResults);
    const localE2eBaseUrl = process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim();
    if (localE2eBaseUrl) application.$['android:usesCleartextTraffic'] = 'true';
    else delete application.$['android:usesCleartextTraffic'];
    return manifest;
  });
  return withDangerousMod(withManifest, ['android', async (dangerous) => {
    if (!dangerous.modRequest.introspect) {
      await writeStagingSourceSet(dangerous.modRequest.platformProjectRoot);
    }
    return dangerous;
  }]);
};

module.exports.insertSigningConfig = insertSigningConfig;
module.exports.stagingSourceFiles = stagingSourceFiles;
module.exports.writeStagingSourceSet = writeStagingSourceSet;
module.exports.pinReferralManifest = pinReferralManifest;
