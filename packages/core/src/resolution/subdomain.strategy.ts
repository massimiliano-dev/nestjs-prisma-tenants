import type { TenantRequestLike } from '../types.js';
import { headerValue, type TenantResolutionStrategy } from './strategy.js';

export interface SubdomainStrategyOptions {
  /** e.g. `example.com` makes `acme.example.com` resolve to `acme`. Use `localhost` for local demos. */
  baseDomain: string;
  /** Labels that never identify a tenant. Default `['www']`. */
  ignore?: string[];
  /** Also read `X-Forwarded-Host` (only behind a trusted proxy). Default false. */
  trustForwardedHost?: boolean;
}

/** `acme.example.com` → `acme`. Only a single label directly under the base domain matches. */
export class SubdomainStrategy implements TenantResolutionStrategy {
  readonly name = 'subdomain';
  private readonly suffix: string;
  private readonly ignore: Set<string>;

  constructor(private readonly options: SubdomainStrategyOptions) {
    this.suffix = `.${options.baseDomain.toLowerCase().replace(/^\./, '')}`;
    this.ignore = new Set(options.ignore ?? ['www']);
  }

  resolve(request: TenantRequestLike): string | null {
    const forwarded = this.options.trustForwardedHost ? headerValue(request, 'x-forwarded-host') : undefined;
    // Read the raw Host header on purpose: framework helpers such as Express `req.hostname` silently
    // switch to X-Forwarded-Host when "trust proxy" is on, which would bypass `trustForwardedHost`.
    const rawHost =
      forwarded?.split(',')[0] ?? headerValue(request, 'host') ?? headerValue(request, ':authority');
    if (!rawHost) return null;
    const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '');
    if (!host.endsWith(this.suffix)) return null;
    const label = host.slice(0, -this.suffix.length);
    if (!label || label.includes('.') || this.ignore.has(label)) return null;
    return label;
  }
}
