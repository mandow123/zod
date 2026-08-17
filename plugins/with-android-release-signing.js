const { AndroidConfig, withAndroidManifest, withAppBuildGradle } = require('expo/config-plugins');

const marker = '// KAI_CLOUDPAY_RELEASE_SIGNING';
const flavorsMarker = '// KAI_CLOUDPAY_DISTRIBUTION_FLAVORS';
const block = `${marker}
def cloudPaySigningFile = rootProject.file('../release-signing.properties')
def cloudPaySigning = new Properties()
if (cloudPaySigningFile.exists()) {
    cloudPaySigningFile.withInputStream { cloudPaySigning.load(it) }
}
def cloudPayEnv = System.getenv()
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
  if (!contents.includes(marker)) {
    if (!next.includes(debugConfig)) throw new Error('Unable to locate generated debug signing config.');
    next = next.replace(debugConfig, releaseConfig);
    next = next.replace(
      /release \{\n\s*\/\/ Caution![\s\S]*?signingConfig signingConfigs\.debug/u,
      `release {\n            signingConfig signingConfigs.release`,
    );
  }
  const signingAnchor = '    signingConfigs {';
  if (!next.includes(flavorsMarker)) {
    if (!next.includes(signingAnchor)) throw new Error('Unable to locate Android signing configuration.');
    const flavors = `${flavorsMarker}\n    flavorDimensions += "distribution"\n    productFlavors {\n        directCn {\n            dimension "distribution"\n        }\n        store {\n            dimension "distribution"\n        }\n    }\n`;
    next = next.replace(signingAnchor, `${flavors}\n${signingAnchor}`);
  }
  return next;
}

module.exports = function withAndroidReleaseSigning(config) {
  const withSigning = withAppBuildGradle(config, (gradle) => {
    gradle.modResults.contents = insertSigningConfig(gradle.modResults.contents);
    return gradle;
  });
  return withAndroidManifest(withSigning, (manifest) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest.modResults);
    const localE2eBaseUrl = process.env.CLOUDPAY_LOCAL_E2E_BASE_URL?.trim();
    if (localE2eBaseUrl) application.$['android:usesCleartextTraffic'] = 'true';
    else delete application.$['android:usesCleartextTraffic'];
    return manifest;
  });
};

module.exports.insertSigningConfig = insertSigningConfig;
