import { createHash, timingSafeEqual } from 'node:crypto';

import { ControlPlaneError } from '../errors.js';

const COOKIE_NAME = 'moonshift_supervisor_session';

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class LoopbackSessionManager {
  private bootstrapSecret: string;
  private consumed = false;
  private sessionToken: string | null = null;
  private expiresAt: number;

  constructor(
    bootstrapSecret: string,
    readonly supervisorId: string,
    readonly expectedOrigin: string,
    readonly bindAddress = '127.0.0.1',
    private readonly now: () => Date = () => new Date(),
    private readonly bootstrapTtlMs = 300_000,
  ) {
    this.bootstrapSecret = bootstrapSecret;
    this.expiresAt = this.now().getTime() + this.bootstrapTtlMs;
    if (bindAddress !== '127.0.0.1' && bindAddress !== '::1')
      throw new ControlPlaneError(
        'LOOPBACK_REQUIRED',
        'Fixture session bootstrap requires a loopback bind',
        400,
      );
  }

  exchange(secret: string, origin: string | undefined): string {
    if (this.consumed)
      throw new ControlPlaneError(
        'BOOTSTRAP_ALREADY_USED',
        'Bootstrap secret already consumed',
        409,
      );
    this.consumed = true;
    if (this.now().getTime() > this.expiresAt)
      throw new ControlPlaneError('BOOTSTRAP_SECRET_EXPIRED', 'Bootstrap secret has expired', 401);
    if (origin !== this.expectedOrigin)
      throw new ControlPlaneError('BOOTSTRAP_ORIGIN_INVALID', 'Bootstrap origin is invalid', 401);
    if (!safeEqual(secret, this.bootstrapSecret))
      throw new ControlPlaneError('BOOTSTRAP_SECRET_INVALID', 'Bootstrap secret is invalid', 401);
    this.sessionToken = createHash('sha256')
      .update(`${secret}:${this.supervisorId}:moonshift-loopback-session`)
      .digest('base64url');
    return `${COOKIE_NAME}=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
  }

  invalidateAttempt(): void {
    if (this.consumed)
      throw new ControlPlaneError(
        'BOOTSTRAP_ALREADY_USED',
        'Bootstrap secret already consumed',
        409,
      );
    this.consumed = true;
  }

  authenticate(cookie: string | undefined): string | null {
    if (this.sessionToken === null || cookie === undefined) return null;
    const token = cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    return token !== undefined && safeEqual(token, this.sessionToken) ? this.supervisorId : null;
  }

  reset(secret: string): void {
    this.bootstrapSecret = secret;
    this.consumed = false;
    this.sessionToken = null;
    this.expiresAt = this.now().getTime() + this.bootstrapTtlMs;
  }
}
