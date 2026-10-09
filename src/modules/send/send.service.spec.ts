import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SendService } from './send.service';
import { StellarService } from '../stellar/stellar.service';
import { UsersRepository } from '../users/users.repository';
import { AppException, AppErrorResponse, ErrorCode } from '../../common/errors';

const G_ADDR = 'G' + 'A'.repeat(55);

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  publicKey: G_ADDR,
  alias: 'known-alias',
  ...overrides,
});

describe('SendService.resolveRecipient', () => {
  let service: SendService;
  let stellar: { getBalances: jest.Mock };
  let users: {
    findByPublicKey: jest.Mock;
    findByAlias: jest.Mock;
  };

  beforeEach(async () => {
    stellar = { getBalances: jest.fn() };
    users = { findByPublicKey: jest.fn(), findByAlias: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendService,
        { provide: StellarService, useValue: stellar },
        { provide: UsersRepository, useValue: users },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<SendService>(SendService);
  });

  describe('direct address', () => {
    it('resolves a raw G... address without touching the alias lookup', async () => {
      users.findByPublicKey.mockResolvedValue(makeUser({ alias: 'alice' }));
      stellar.getBalances.mockResolvedValue([{ asset_code: 'USDC', balance: '10' }]);

      const info = await service.resolveRecipient(G_ADDR);

      expect(info).toEqual({
        address: G_ADDR,
        alias: 'alice',
        exists: true,
        hasUsdcTrustline: true,
      });
      expect(users.findByAlias).not.toHaveBeenCalled();
    });
  });

  describe('known alias', () => {
    it('resolves a known alias to its registered public key', async () => {
      users.findByAlias.mockResolvedValue(
        makeUser({ publicKey: G_ADDR, alias: 'known-alias' }),
      );
      stellar.getBalances.mockResolvedValue([{ asset_code: 'XLM', balance: '5' }]);

      const info = await service.resolveRecipient('known-alias');

      expect(info.address).toBe(G_ADDR);
      expect(info.alias).toBe('known-alias');
      expect(info.exists).toBe(true);
      expect(users.findByPublicKey).not.toHaveBeenCalled();
    });
  });

  describe('unknown alias', () => {
    it('throws AppException with ErrorCode.INVALID_RECIPIENT', async () => {
      users.findByAlias.mockResolvedValue(null);

      const err: AppException = await service
        .resolveRecipient('ghost-alias')
        .then(
          () => {
            throw new Error('expected resolveRecipient to throw');
          },
          (e) => e,
        );

      expect(err).toBeInstanceOf(AppException);
      const response = err.getResponse() as AppErrorResponse;
      expect(response.error).toBe(ErrorCode.INVALID_RECIPIENT);
    });
  });

  describe('USDC trustline detection', () => {
    it('sets hasUsdcTrustline=true only when a balance record has asset_code === "USDC"', async () => {
      users.findByPublicKey.mockResolvedValue(null);

      // No USDC among the balances
      stellar.getBalances.mockResolvedValue([
        { asset_code: 'XLM', balance: '5' },
        { asset_code: 'FOO', balance: '1' },
      ]);
      const without = await service.resolveRecipient(G_ADDR);
      expect(without.exists).toBe(true);
      expect(without.hasUsdcTrustline).toBe(false);

      // USDC present
      stellar.getBalances.mockResolvedValue([{ asset_code: 'USDC', balance: '10' }]);
      const withUsdc = await service.resolveRecipient(G_ADDR);
      expect(withUsdc.hasUsdcTrustline).toBe(true);
    });
  });

  describe('Horizon outage', () => {
    it('yields exists=false without throwing when getBalances rejects', async () => {
      users.findByPublicKey.mockResolvedValue(null);
      stellar.getBalances.mockRejectedValue(new Error('Horizon timeout'));

      const info = await service.resolveRecipient(G_ADDR);

      expect(info.exists).toBe(false);
      expect(info.hasUsdcTrustline).toBe(false);
      expect(info.address).toBe(G_ADDR);
    });
  });
});
