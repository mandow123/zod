const algorithms = new Set(['ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ssh-rsa']);

export type SshPublicKeyCheck = Readonly<{
  valid: boolean; algorithm: string | null; commentIgnored: boolean; error: string | null;
}>;

export function checkSshPublicKey(input: string): SshPublicKeyCheck {
  const value = input.trim();
  if (/-----BEGIN [^-]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----/iu.test(value)) {
    return { valid: false, algorithm: null, commentIgnored: false, error: '检测到私钥内容。只允许提交 OpenSSH 公钥。' };
  }
  const parts = value.split(/\s+/u);
  const algorithm = parts[0] ?? null;
  if (!algorithm || !algorithms.has(algorithm) || !parts[1] || !/^[A-Za-z0-9+/]+={0,2}$/u.test(parts[1])) {
    return { valid: false, algorithm, commentIgnored: parts.length > 2,
      error: '请输入受支持的 OpenSSH 公钥：ed25519、硬件 ed25519、ECDSA P-256 或 RSA。' };
  }
  if (algorithm === 'ssh-rsa') {
    const bits = rsaModulusBits(parts[1]);
    if (bits === null) return { valid: false, algorithm, commentIgnored: parts.length > 2, error: 'RSA 公钥格式无法识别，请检查后重试。' };
    if (bits < 3072) return { valid: false, algorithm, commentIgnored: parts.length > 2, error: 'RSA 公钥至少需要 3072 位。' };
  }
  return { valid: true, algorithm, commentIgnored: parts.length > 2, error: null };
}

function rsaModulusBits(encoded: string) {
  try {
    const bytes = Uint8Array.from(globalThis.atob(encoded), (character) => character.charCodeAt(0));
    let offset = 0;
    const read = () => {
      if (offset + 4 > bytes.length) throw new Error('truncated');
      const length = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16)
        | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
      offset += 4; if (offset + length > bytes.length) throw new Error('truncated');
      const result = bytes.slice(offset, offset + length); offset += length; return result;
    };
    const name = new TextDecoder().decode(read());
    if (name !== 'ssh-rsa') return null;
    read();
    let modulus = read();
    while (modulus.length && modulus[0] === 0) modulus = modulus.slice(1);
    if (!modulus.length) return null;
    let leading = 0; let mask = 0x80;
    while ((modulus[0]! & mask) === 0) { leading += 1; mask >>= 1; }
    return modulus.length * 8 - leading;
  } catch { return null; }
}
