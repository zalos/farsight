// Azure DevOps auth kinds (docs/proposals/work-items-sync.md §10).
//
//   pat                org-scoped personal access token, `Basic base64(':' + pat)`
//   az-cli             `az account get-access-token --resource <ADO>`, `Bearer …`, in process
//   entra-device-code  not built: needs MSAL (@azure/msal-node) and a registered client id
//   entra-auth-code    not built: needs MSAL, a client id and a loopback redirect
//
// Every kind returns a closure that yields the Authorization header value. The
// value is never logged, never thrown, never written; errors name the kind.
import { execFile } from 'node:child_process';
import type { AuthConfig, SourceConfig } from '@farsight/work';
import { resolveSecret, SecretUnavailable } from '@farsight/work';
import { basicPat } from './http.js';

/** The Azure DevOps resource id Entra tokens are requested for. */
export const AZDO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

/** An auth kind this provider knows but has not built — names what it needs. */
export class AzdoAuthNotBuilt extends Error {
  constructor(readonly kind: string, readonly needs: string) {
    super(`Azure DevOps auth kind ${kind} is not built yet: it needs ${needs}`);
    this.name = 'AzdoAuthNotBuilt';
  }
}

/** The credential could not be obtained. Names the kind or reference, never a value. */
export class AzdoAuthUnavailable extends Error {
  constructor(readonly kind: string, readonly why: string) {
    super(`Azure DevOps credential (${kind}) unavailable: ${why}`);
    this.name = 'AzdoAuthUnavailable';
  }
}

export type AzRunner = (cmd: string, args: string[]) => Promise<string>;

const runAz: AzRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });

export interface AuthOptions {
  /** injectable for tests: runs `az` */
  azRunner?: AzRunner;
  /** injectable for tests: resolves a secret reference */
  resolve?: (ref: string) => Promise<string>;
  now?: () => number;
}

export interface Authorizer {
  kind: AuthConfig['kind'];
  /** yields the Authorization header value; call per request */
  header: () => Promise<string>;
}

/**
 * Build the authorizer for a source. `secret` is the value the engine already
 * resolved (for `pat`); when absent the provider resolves `auth.secret` itself.
 */
export async function authorizerFor(cfg: SourceConfig, secret: string | undefined, opts: AuthOptions = {}): Promise<Authorizer> {
  const kind = cfg.auth?.kind ?? 'pat';
  if (kind === 'pat') {
    let pat = secret;
    if (!pat) {
      const ref = cfg.auth?.secret;
      if (!ref) throw new AzdoAuthUnavailable('pat', 'no auth.secret reference in the source settings');
      try {
        pat = await (opts.resolve ?? ((r: string) => resolveSecret(r)))(ref);
      } catch (err) {
        if (err instanceof SecretUnavailable) throw err; // the engine words it as a credential problem
        throw new AzdoAuthUnavailable('pat', `the reference ${ref} could not be read`);
      }
    }
    const value = basicPat(pat);
    pat = undefined;
    return { kind, header: async () => value };
  }
  if (kind === 'az-cli') {
    const run = opts.azRunner ?? runAz;
    const now = opts.now ?? Date.now;
    let token: string | undefined;
    let expires = 0;
    const fetchToken = async () => {
      let out: string;
      try {
        out = await run('az', ['account', 'get-access-token', '--resource', AZDO_RESOURCE, '--output', 'json']);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw new AzdoAuthUnavailable('az-cli', code === 'ENOENT' ? 'the Azure CLI (az) is not installed' : 'az could not issue a token — run az login');
      }
      let j: { accessToken?: string; expires_on?: number; expiresOn?: string };
      try { j = JSON.parse(out); } catch { throw new AzdoAuthUnavailable('az-cli', 'az answered something that is not a token'); }
      if (!j.accessToken) throw new AzdoAuthUnavailable('az-cli', 'az answered without a token');
      token = j.accessToken;
      expires = j.expires_on ? j.expires_on * 1000 : j.expiresOn ? Date.parse(j.expiresOn) : now() + 50 * 60_000;
    };
    await fetchToken();
    return {
      kind,
      header: async () => {
        // Entra tokens live about an hour; refresh five minutes early
        if (!token || now() > expires - 5 * 60_000) await fetchToken();
        return `Bearer ${token}`;
      },
    };
  }
  if (kind === 'entra-device-code') throw new AzdoAuthNotBuilt(kind, 'MSAL (@azure/msal-node), an Entra app client id and tenant, and the scope 499b84ac-1321-427f-aa17-267ca6975798/.default');
  if (kind === 'entra-auth-code') throw new AzdoAuthNotBuilt(kind, 'MSAL (@azure/msal-node), an Entra app client id and tenant, and a loopback redirect with PKCE');
  throw new AzdoAuthNotBuilt(kind, 'an Azure DevOps auth kind: pat, az-cli, entra-device-code or entra-auth-code');
}
