import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { jwtAccessSecret } from '../../common/env.js';
import { SessionService } from './session.service.js';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  /** Session the token belongs to. Absent on tokens issued before sessions existed. */
  sid?: string;
  /** 'access' — guards against a refresh token being presented as an access token. */
  typ?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly sessions: SessionService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // No literal fallback: env validation guarantees this is set at boot.
      secretOrKey: jwtAccessSecret(),
    });
  }

  /**
   * Return value is attached to req.user. The token's signature is not enough on
   * its own: the session it names must still be live and its account active, so
   * logout, a password reset or a deactivation cuts the token off immediately.
   * The role is read from the database, never trusted from the token.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    // Tokens minted before server-side sessions carry no `sid` and are refused,
    // which signs those browsers out once; the next login issues a proper one.
    if (payload.typ !== 'access' || !payload.sid) {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }
    const user = await this.sessions.validate(payload.sid, payload.sub);
    if (!user) throw new UnauthorizedException('Your session has ended. Please sign in again.');
    return { id: user.id, email: user.email, role: user.role, sessionId: payload.sid };
  }
}
