import { describe, expect, it } from 'vitest';
import { isVpcPrivateIpv4, listeningCloudPayPorts, parseArguments, parseEnvironmentFile } from '../deploy/aws-ubuntu/preflight-host.mjs';

describe('AWS host preflight parsing', () => {
  it('requires an explicit VPC address, baseline and immutable report target', () => {
    expect(parseArguments(['--private-ip', '172.31.8.9', '--baseline', '/tmp/before.json', '--report', '/tmp/report.json']))
      .toEqual({ 'private-ip': '172.31.8.9', baseline: '/tmp/before.json', report: '/tmp/report.json' });
    expect(() => parseArguments(['--private-ip', '172.31.8.9'])).toThrow('--baseline is required');
    expect(() => parseArguments(['--unknown', 'value'])).toThrow('Unknown argument');
  });

  it('accepts only the VPC CIDR fixed by the firewall contract', () => {
    expect(isVpcPrivateIpv4('172.31.0.1')).toBe(true);
    expect(isVpcPrivateIpv4('172.31.255.254')).toBe(true);
    expect(isVpcPrivateIpv4('172.30.1.2')).toBe(false);
    expect(isVpcPrivateIpv4('10.0.0.1')).toBe(false);
    expect(isVpcPrivateIpv4('172.31.999.1')).toBe(false);
  });

  it('parses systemd-style assignments without exposing or truncating values', () => {
    expect(parseEnvironmentFile("A=one\nB='two=three'\n# comment\nC=literal\\nvalue\n"))
      .toEqual({ A: 'one', B: 'two=three', C: 'literal\\nvalue' });
    expect(() => parseEnvironmentFile('A=one\nA=two\n')).toThrow('duplicate environment variable A');
    expect(() => parseEnvironmentFile('not an assignment')).toThrow('line 1');
  });

  it('detects both dedicated listener ports in IPv4 and IPv6 ss output', () => {
    const source = [
      'LISTEN 0 4096 127.0.0.1:4100 0.0.0.0:* users:(("node",pid=1,fd=1))',
      'LISTEN 0 4096 [172.31.4.5]:4154 [::]:* users:(("systemd",pid=1,fd=2))',
      'LISTEN 0 4096 127.0.0.1:9999 0.0.0.0:*',
    ].join('\n');
    expect(listeningCloudPayPorts(source)).toEqual([4100, 4154]);
  });
});
