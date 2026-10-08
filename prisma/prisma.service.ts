import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { isProfilePictureMockEnabled } from '../src/modules/auth/profile-picture-mock.config';

interface PrismaQueryEvent {
  query: string;
  duration: number;
}

interface QueryEventEmitter {
  $on(event: 'query', callback: (event: PrismaQueryEvent) => void): void;
}

function isQueryLogEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.PRISMA_QUERY_LOG === 'true'
  );
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);
  private readonly queryLogEnabled: boolean;
  private queryCount = 0;

  constructor() {
    const queryLogEnabled = isQueryLogEnabled();
    const options: Prisma.PrismaClientOptions = queryLogEnabled
      ? { log: [{ emit: 'event', level: 'query' }] }
      : {};

    super(options);
    this.queryLogEnabled = queryLogEnabled;
  }

  async onModuleInit() {
    if (this.queryLogEnabled) {
      this.registerQueryLogger();
    }

    if (isProfilePictureMockEnabled() || !process.env.DATABASE_URL) {
      return;
    }

    await this.$connect();
  }

  getQueryCount(): number {
    return this.queryCount;
  }

  resetQueryCount(): void {
    this.queryCount = 0;
  }

  private registerQueryLogger(): void {
    (this as unknown as QueryEventEmitter).$on('query', (event) => {
      this.queryCount += 1;
      this.logger.debug(
        `prisma.query #${this.queryCount} (${event.duration}ms) ${event.query}`,
      );
    });
  }
}
