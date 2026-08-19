import { describe, expect, it } from 'vitest';
import dockerfile from '../../Dockerfile?raw';
import nginxConfig from '../../default.conf.template?raw';
import readme from '../../README.md?raw';

describe('administrator web deployment contract', () => {
  it('uses a multi-stage Node 24 build and non-root nginx runtime', () => {
    expect(dockerfile).toMatch(/^FROM node:24-alpine AS build/mu);
    expect(dockerfile).toMatch(/^FROM nginx:1\.28-alpine AS runtime/mu);
    expect(dockerfile).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(dockerfile).toContain('USER nginx');
    expect(dockerfile).toContain('pid /tmp/nginx.pid;');
    expect(dockerfile).toContain("'/^user[[:space:]]/d'");
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).toContain('HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3');
    expect(dockerfile).toContain('http://127.0.0.1:8080/healthz');
    expect(dockerfile).toContain('VITE_ADMIN_API_ORIGIN');
    expect(dockerfile).toContain('ADMIN_API_ORIGIN');
    expect(dockerfile).toContain('.admin-api-origin');
    expect(dockerfile).toContain('test \\"$value\\" = \\"$(cat /usr/share/nginx/html/.admin-api-origin)\\"');
    expect(dockerfile).toContain('new URL(value)');
    expect(dockerfile).toContain("envsubst '$ADMIN_API_ORIGIN'");
    expect(dockerfile).toContain('/etc/nginx/conf.d/default.conf');
  });

  it('requires an exact, safe build/runtime origin agreement without a default', () => {
    expect(dockerfile).toContain('must equal ADMIN_API_ORIGIN');
    expect(dockerfile).toContain('test -n \\"$value\\"');
    expect(dockerfile).toContain("value === url.origin && url.protocol === 'https:'");
    expect(dockerfile).toContain('case \\"$value\\" in *[[:space:]]*) exit 64 ;; esac');
    expect(dockerfile).not.toMatch(/ADMIN_API_ORIGIN=https?:\/\/[^$\s"']+/u);
    expect(readme).toContain('identical');
  });

  it('documents a placeholder HTTPS startup contract without embedding a real origin', () => {
    expect(readme).toContain('VITE_ADMIN_API_ORIGIN=https://admin-api.example.invalid');
    expect(readme).toContain('ADMIN_API_ORIGIN=https://admin-api.example.invalid');
    expect(readme).toContain('mismatched runtime value makes the container exit');
  });

  it('enforces the SPA, cache, health and response-security contracts', () => {
    expect(nginxConfig).toContain('listen 8080');
    expect(nginxConfig).toContain('server_tokens off');
    expect(nginxConfig).toContain('location = /healthz');
    expect(nginxConfig).toContain("default-src 'self'; connect-src 'self' ${ADMIN_API_ORIGIN}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    expect(nginxConfig).toContain('Strict-Transport-Security');
    expect(nginxConfig).toContain('X-Content-Type-Options');
    expect(nginxConfig).toContain('Referrer-Policy');
    expect(nginxConfig).toContain('Permissions-Policy');
    expect(nginxConfig).toContain('try_files $uri $uri/ /index.html');
    expect(nginxConfig).toContain('max-age=31536000, immutable');
    expect(nginxConfig).toContain('location = /index.html');
    expect(nginxConfig).toContain('no-store, max-age=0');
    // Nested locations set cache headers, which otherwise suppress inherited
    // add_header directives in nginx. Require the security policy on every
    // response path rather than relying on server-level inheritance.
    expect(nginxConfig.match(/add_header Content-Security-Policy/g)?.length).toBe(5);
    expect(nginxConfig.match(/add_header Strict-Transport-Security/g)?.length).toBe(5);
    expect(nginxConfig.match(/add_header X-Content-Type-Options/g)?.length).toBe(5);
  });
});
