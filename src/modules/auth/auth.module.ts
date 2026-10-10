import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { getJwtSecret } from '../../config/jwt.config';
import { AuthChallengeCron } from './auth-challenge.cron';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ProfilePictureAuthGuard } from './profile-picture-auth.guard';

@Module({
  imports: [
    PassportModule,
    AuditLogModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: () => ({
        secret: getJwtSecret(),
        signOptions: { expiresIn: '1h' },
      }),
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    AuthRateLimitGuard,
    AuthChallengeCron,
    JwtAuthGuard,
    ProfilePictureAuthGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtModule, JwtAuthGuard, ProfilePictureAuthGuard],
})
export class AuthModule {}
