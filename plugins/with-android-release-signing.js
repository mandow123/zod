const { withAppBuildGradle } = require('expo/config-plugins');

const marker = '// KAI_CLOUDPAY_RELEASE_SIGNING';
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
  if (contents.includes(marker)) return contents;
  const anchor = 'android {';
  if (!contents.includes(anchor)) throw new Error('Unable to locate Android configuration.');
  let next = `${block}\n${contents}`;
  const debugConfig = `        debug {\n            storeFile file('debug.keystore')\n            storePassword 'android'\n            keyAlias 'androiddebugkey'\n            keyPassword 'android'\n        }`;
  const releaseConfig = `${debugConfig}\n        release {\n            if (cloudPayHasReleaseSigning) {\n                storeFile file(cloudPayStoreFile)\n                storePassword cloudPayStorePassword\n                keyAlias cloudPayKeyAlias\n                keyPassword cloudPayKeyPassword\n                enableV1Signing false\n                enableV2Signing true\n                enableV3Signing true\n                enableV4Signing true\n            }\n        }`;
  if (!next.includes(debugConfig)) throw new Error('Unable to locate generated debug signing config.');
  next = next.replace(debugConfig, releaseConfig);
  next = next.replace(
    /release \{\n\s*\/\/ Caution![\s\S]*?signingConfig signingConfigs\.debug/u,
    `release {\n            signingConfig signingConfigs.release`,
  );
  return next;
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (gradle) => {
    gradle.modResults.contents = insertSigningConfig(gradle.modResults.contents);
    return gradle;
  });
};

module.exports.insertSigningConfig = insertSigningConfig;
