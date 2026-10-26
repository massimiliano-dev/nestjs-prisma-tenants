import { describe, expect, it } from 'vitest';
import {
  CompositeStrategy,
  HeaderStrategy,
  JwtClaimStrategy,
  resolveTenantSlug,
  SubdomainStrategy,
} from '../src/index.js';

const req = (headers: Record<string, string>, hostname?: string) => ({ headers, hostname });
const jwt = (payload: object) => `Bearer x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('SubdomainStrategy', () => {
  const s = new SubdomainStrategy({ baseDomain: 'example.com' });

  it('reads a single label under the base domain', () => {
    expect(s.resolve(req({ host: 'acme.example.com' }))).toBe('acme');
    expect(s.resolve(req({ host: 'ACME.example.com:3000' }))).toBe('acme');
    // req.hostname is ignored: it may come from X-Forwarded-Host when Express trusts proxies.
    expect(s.resolve(req({ host: 'internal' }, 'globex.example.com'))).toBeNull();
  });

  it('ignores the apex, www, nested labels and other domains', () => {
    expect(s.resolve(req({ host: 'example.com' }))).toBeNull();
    expect(s.resolve(req({ host: 'www.example.com' }))).toBeNull();
    expect(s.resolve(req({ host: 'a.b.example.com' }))).toBeNull();
    expect(s.resolve(req({ host: 'acme.evil.com' }))).toBeNull();
    expect(s.resolve(req({ host: 'acmeexample.com' }))).toBeNull();
  });

  it('uses X-Forwarded-Host only when trusted', () => {
    const headers = { host: 'internal:8080', 'x-forwarded-host': 'acme.example.com' };
    expect(s.resolve(req(headers))).toBeNull();
    expect(
      new SubdomainStrategy({ baseDomain: 'example.com', trustForwardedHost: true }).resolve(req(headers)),
    ).toBe('acme');
  });
});

describe('HeaderStrategy', () => {
  it('reads x-tenant-id by default and custom headers', () => {
    expect(new HeaderStrategy().resolve(req({ 'x-tenant-id': 'acme' }))).toBe('acme');
    expect(new HeaderStrategy({ header: 'X-Org' }).resolve(req({ 'x-org': 'globex' }))).toBe('globex');
    expect(new HeaderStrategy().resolve(req({}))).toBeNull();
  });
});

describe('JwtClaimStrategy', () => {
  const unsafe = { unsafeDecodeWithoutVerification: true } as const;

  it('refuses to be built without verification unless explicitly unsafe', () => {
    expect(() => new JwtClaimStrategy({})).toThrow(/verify/);
  });

  it('uses the verified payload and rejects tokens that fail verification', async () => {
    const verify = async (token: string) => {
      if (token !== 'good') throw new Error('bad signature');
      return { org: { slug: 'initech' } };
    };
    const s = new JwtClaimStrategy({ claim: 'org.slug', verify });
    expect(await s.resolve(req({ authorization: 'Bearer good' }))).toBe('initech');
    expect(await s.resolve(req({ authorization: jwt({ org: { slug: 'acme' } }) }))).toBeNull();
  });

  it('decodes the claim in unsafe mode, including dotted paths', async () => {
    expect(await new JwtClaimStrategy(unsafe).resolve(req({ authorization: jwt({ tenant: 'acme' }) }))).toBe(
      'acme',
    );
    expect(
      await new JwtClaimStrategy({ ...unsafe, claim: 'org.slug' }).resolve(
        req({ authorization: jwt({ org: { slug: 'initech' } }) }),
      ),
    ).toBe('initech');
  });

  it('returns null on malformed tokens or missing claims', async () => {
    const s = new JwtClaimStrategy(unsafe);
    expect(await s.resolve(req({ authorization: 'Bearer nope' }))).toBeNull();
    expect(await s.resolve(req({ authorization: 'Bearer a.%%%.c' }))).toBeNull();
    expect(await s.resolve(req({ authorization: jwt({ other: 1 }) }))).toBeNull();
  });
});

describe('resolveTenantSlug / CompositeStrategy', () => {
  it('returns the first valid slug and skips invalid values', async () => {
    const strategies = [new HeaderStrategy(), new SubdomainStrategy({ baseDomain: 'example.com' })];
    expect(
      await resolveTenantSlug(strategies, req({ 'x-tenant-id': 'Bad Slug!', host: 'acme.example.com' })),
    ).toBe('acme');
    expect(await new CompositeStrategy(strategies).resolve(req({ 'x-tenant-id': ' Globex ' }))).toBe(
      'globex',
    );
    expect(await resolveTenantSlug(strategies, req({ host: 'example.com' }))).toBeNull();
  });
});
