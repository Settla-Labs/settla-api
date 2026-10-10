import { Logger } from '@nestjs/common';

export function isProfilePictureMockEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === 'development' && env.MOCK_PROFILE_UPLOAD === 'true';
}

export function warnIfProfilePictureMockEnabled(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Logger, 'warn'> = new Logger('Security'),
): void {
  if (isProfilePictureMockEnabled(env)) {
    logger.warn(
      'SECURITY WARNING: simulated authentication is enabled exclusively for profile-picture uploads in development.',
    );
  }
}
