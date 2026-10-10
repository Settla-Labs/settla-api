import { ConfigService } from '@nestjs/config';
import { SendService } from './send.service';
import { StellarService } from '../stellar/stellar.service';
import { UsersRepository } from '../users/users.repository';
import { AppException, ErrorCode } from '../../common/errors';

const SOURCE = 'G' + 'A'.repeat(55);
const DEST = 'G' + 'B'.repeat(55);
const TREASURY = 'G' + 'C'.repeat(55);

function buildService(env: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    IKASH_TREASURY_ADDRESS: TREASURY,
    ...env,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;

  const stellar = {
    buildUnsignedUsdcSend: jest.fn().mockResolvedValue({
      xdr: 'UNSIGNED_XDR',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }),
    getBalances: jest.fn(),
  } as unknown as jest.Mocked<StellarService>;

  const users = {
    findByPublicKey: jest.fn().mockResolvedValue(null),
    findByAlias: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<UsersRepository>;

  const service = new SendService(config, stellar, users);
  return { service, stellar, users };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await expect(promise).rejects.toMatchObject({
    response: expect.objectContaining({ error: code }),
  });
}

describe('SendService.prepare', () => {
  describe('self-send guard', () => {
    it('rejects a self-send by address before any Horizon call', async () => {
      const { service, stellar } = buildService();

      await expectCode(
        service.prepare(SOURCE, SOURCE, '1'),
        ErrorCode.SELF_SEND,
      );
      expect(stellar.buildUnsignedUsdcSend).not.toHaveBeenCalled();
      expect(stellar.getBalances).not.toHaveBeenCalled();
    });

    it('rejects a self-send when the alias resolves to the sender', async () => {
      const { service, stellar, users } = buildService();
      users.findByAlias.mockResolvedValue({
        publicKey: SOURCE,
        alias: 'me',
      } as never);

      await expectCode(
        service.prepare(SOURCE, 'me', '1'),
        ErrorCode.SELF_SEND,
      );
      expect(stellar.buildUnsignedUsdcSend).not.toHaveBeenCalled();
    });
  });

  describe('fee math (default 0.3% = 30 bps)', () => {
    it.each([
      ['1', '0.003', '1.003'],
      ['0.1234567', '0.0003703', '0.123827'],
      ['1000', '3', '1003'],
    ])(
      'amount %s -> fee %s, total %s (total = amount + fee)',
      async (amount, fee, total) => {
        const { service, stellar } = buildService();

        const result = await service.prepare(SOURCE, DEST, amount);

        expect(result.amount).toBe(amount);
        expect(result.fee).toBe(fee);
        expect(result.total).toBe(total);
        expect(result.asset).toBe('USDC');
        expect(result.unsignedXdr).toBe('UNSIGNED_XDR');
        expect(result.recipient).toEqual({ address: DEST, alias: null });
        expect(stellar.buildUnsignedUsdcSend).toHaveBeenCalledWith({
          sourcePublicKey: SOURCE,
          destination: DEST,
          amount,
          feeAddress: TREASURY,
          feeAmount: fee,
        });
      },
    );

    it('honours SEND_CRYPTO_FEE_PERCENT overrides', async () => {
      const { service } = buildService({ SEND_CRYPTO_FEE_PERCENT: '1' });

      const result = await service.prepare(SOURCE, DEST, '100');

      expect(result.fee).toBe('1');
      expect(result.total).toBe('101');
    });

    it('falls back to 30 bps when the configured percent is invalid', async () => {
      const { service } = buildService({ SEND_CRYPTO_FEE_PERCENT: 'abc' });

      const result = await service.prepare(SOURCE, DEST, '1000');

      expect(result.fee).toBe('3');
    });
  });

  describe('rejections', () => {
    it('rejects an amount too small for the 0.3% fee', async () => {
      const { service, stellar } = buildService();

      // 0.0000001 = 1 stroop -> fee = floor(1 * 30 / 10000) = 0
      await expectCode(
        service.prepare(SOURCE, DEST, '0.0000001'),
        ErrorCode.AMOUNT_TOO_SMALL,
      );
      expect(stellar.buildUnsignedUsdcSend).not.toHaveBeenCalled();
    });

    it('rejects a zero amount', async () => {
      const { service } = buildService();

      await expectCode(
        service.prepare(SOURCE, DEST, '0'),
        ErrorCode.AMOUNT_TOO_SMALL,
      );
    });

    it.each(['-1', '1.12345678', 'abc', ''])(
      'rejects the malformed amount "%s"',
      async (amount) => {
        const { service } = buildService();

        await expectCode(
          service.prepare(SOURCE, DEST, amount),
          ErrorCode.INVALID_AMOUNT,
        );
      },
    );

    it('throws MISSING_FEE_COLLECTOR when IKASH_TREASURY_ADDRESS is unset', async () => {
      const { service, stellar } = buildService({
        IKASH_TREASURY_ADDRESS: undefined,
      });

      await expectCode(
        service.prepare(SOURCE, DEST, '1'),
        ErrorCode.MISSING_FEE_COLLECTOR,
      );
      expect(stellar.buildUnsignedUsdcSend).not.toHaveBeenCalled();
    });

    it('rejects an unknown alias with INVALID_RECIPIENT', async () => {
      const { service } = buildService();

      await expectCode(
        service.prepare(SOURCE, 'nobody', '1'),
        ErrorCode.INVALID_RECIPIENT,
      );
    });
  });

  describe('recipient resolution', () => {
    it('returns the alias of a known address', async () => {
      const { service, users } = buildService();
      users.findByPublicKey.mockResolvedValue({
        publicKey: DEST,
        alias: 'bob',
      } as never);

      const result = await service.prepare(SOURCE, DEST, '1');

      expect(result.recipient).toEqual({ address: DEST, alias: 'bob' });
    });

    it('resolves an alias to its public key', async () => {
      const { service, users, stellar } = buildService();
      users.findByAlias.mockResolvedValue({
        publicKey: DEST,
        alias: 'bob',
      } as never);

      const result = await service.prepare(SOURCE, ' bob ', '1');

      expect(users.findByAlias).toHaveBeenCalledWith('bob');
      expect(result.recipient).toEqual({ address: DEST, alias: 'bob' });
      expect(stellar.buildUnsignedUsdcSend).toHaveBeenCalledWith(
        expect.objectContaining({ destination: DEST }),
      );
    });
  });
});

describe('SendService stroop conversion helpers (via prepare)', () => {
  // 30 bps fee; use SEND_CRYPTO_FEE_PERCENT=0.01 so fee never alters the amount check.
  it.each([
    ['1', 10_000_000n],
    ['0.0000001', 1n],
    ['0.1234567', 1_234_567n],
    ['1000', 10_000_000_000n],
  ])('"%s" converts to %s stroops and round-trips', async (amount, stroops) => {
    const { service } = buildService({ SEND_CRYPTO_FEE_PERCENT: '100' });
    const toStroops = (service as any).toStroops.bind(service);
    const fromStroops = (service as any).fromStroops.bind(service);

    expect(toStroops(amount)).toBe(stroops);
    expect(fromStroops(stroops)).toBe(amount);
  });

  it('trims trailing zeros so "1.5000000" renders as "1.5"', async () => {
    const { service } = buildService();
    const fromStroops = (service as any).fromStroops.bind(service);

    expect(fromStroops(15_000_000n)).toBe('1.5');
    expect(fromStroops((service as any).toStroops('1.5000000'))).toBe('1.5');
  });

  it.each(['-1', '0.', '.5', '1e3', '1.12345678', ' 1'])(
    'rejects "%s" with INVALID_AMOUNT',
    async (amount) => {
      const { service } = buildService();

      await expectCode(
        service.prepare(SOURCE, DEST, amount),
        ErrorCode.INVALID_AMOUNT,
      );
    },
  );
});
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
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SendService } from './send.service';
import { StellarService } from '../stellar/stellar.service';
import { UsersRepository } from '../users/users.repository';
import { AppException, ErrorCode } from '../../common/errors';

describe('SendService', () => {
  let service: SendService;
  let configService: { get: jest.Mock };
  let stellarService: {
    getBalances: jest.Mock;
    buildUnsignedUsdcSend: jest.Mock;
    submitSignedXdr: jest.Mock;
  };
  let usersRepository: {
    findByPublicKey: jest.Mock;
    findByAlias: jest.Mock;
  };

  const VALID_STELLAR_ADDRESS_1 =
    'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTCVQPTYEQGIFO';
  const VALID_STELLAR_ADDRESS_2 =
    'GA2H7FUBASEKCXYOrHNT42Z9B8VEXEM462K6XGYKHYN4M33I7QOPP2X5'.slice(0, 56);
  const TREASURY_ADDRESS =
    'GCDNWU7O4M4PGBKFMQO6US56S24UJJ7Y5E6XG4U777Y3RUXNEXEXAMPLE';

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'SEND_CRYPTO_FEE_PERCENT') return '0.3';
        if (key === 'IKASH_TREASURY_ADDRESS') return TREASURY_ADDRESS;
        return null;
      }),
    };

    stellarService = {
      getBalances: jest.fn(),
      buildUnsignedUsdcSend: jest.fn(),
      submitSignedXdr: jest.fn(),
    };

    usersRepository = {
      findByPublicKey: jest.fn(),
      findByAlias: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendService,
        { provide: ConfigService, useValue: configService },
        { provide: StellarService, useValue: stellarService },
        { provide: UsersRepository, useValue: usersRepository },
      ],
    }).compile();

    service = module.get<SendService>(SendService);
  });

  describe('resolveRecipient (#104)', () => {
    it('resolves a direct Stellar public key without alias lookup', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.getBalances.mockResolvedValue([
        { asset_code: 'USDC', balance: '100.0000000' },
      ]);

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_1,
        alias: null,
        exists: true,
        hasUsdcTrustline: true,
      });
      expect(usersRepository.findByPublicKey).toHaveBeenCalledWith(
        VALID_STELLAR_ADDRESS_1,
      );
    });

    it('resolves a direct Stellar public key with linked user alias', async () => {
      usersRepository.findByPublicKey.mockResolvedValue({
        publicKey: VALID_STELLAR_ADDRESS_1,
        alias: 'alice',
      });
      stellarService.getBalances.mockResolvedValue([
        { asset_type: 'native', balance: '50.0000000' },
      ]);

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_1,
        alias: 'alice',
        exists: true,
        hasUsdcTrustline: false,
      });
    });

    it('resolves a known alias to its underlying address and alias', async () => {
      usersRepository.findByAlias.mockResolvedValue({
        publicKey: VALID_STELLAR_ADDRESS_2,
        alias: 'bob',
      });
      stellarService.getBalances.mockResolvedValue([
        { asset_code: 'USDC', balance: '25.0000000' },
      ]);

      const result = await service.resolveRecipient('bob');

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_2,
        alias: 'bob',
        exists: true,
        hasUsdcTrustline: true,
      });
      expect(usersRepository.findByAlias).toHaveBeenCalledWith('bob');
    });

    it('throws AppException with INVALID_RECIPIENT for an unknown alias', async () => {
      usersRepository.findByAlias.mockResolvedValue(null);

      await expect(service.resolveRecipient('unknown_alias')).rejects.toThrow(
        AppException,
      );

      try {
        await service.resolveRecipient('unknown_alias');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.INVALID_RECIPIENT);
      }
    });

    it('sets hasUsdcTrustline to true only when balance has asset_code USDC', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.getBalances.mockResolvedValue([
        { asset_type: 'native', balance: '10.0000000' },
        { asset_code: 'EURC', balance: '5.0000000' },
      ]);

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result.exists).toBe(true);
      expect(result.hasUsdcTrustline).toBe(false);
    });

    it('swallows getBalances rejection and returns exists = false without throwing', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.getBalances.mockRejectedValue(
        new Error('Account not found on Horizon'),
      );

      const result = await service.resolveRecipient(VALID_STELLAR_ADDRESS_1);

      expect(result).toEqual({
        address: VALID_STELLAR_ADDRESS_1,
        alias: null,
        exists: false,
        hasUsdcTrustline: false,
      });
    });
  });

  describe('prepare (#102)', () => {
    it('throws AppException with SELF_SEND if recipient resolves to sourcePublicKey', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);

      await expect(
        service.prepare(VALID_STELLAR_ADDRESS_1, VALID_STELLAR_ADDRESS_1, '10'),
      ).rejects.toThrow(AppException);

      try {
        await service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_1,
          '10',
        );
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.SELF_SEND);
      }

      expect(stellarService.buildUnsignedUsdcSend).not.toHaveBeenCalled();
    });

    it('throws AppException with AMOUNT_TOO_SMALL when fee calculates to 0 stroops', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);

      await expect(
        service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_2,
          '0.0000001',
        ),
      ).rejects.toThrow(AppException);

      try {
        await service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_2,
          '0.0000001',
        );
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.AMOUNT_TOO_SMALL);
      }
    });

    it('throws AppException with MISSING_FEE_COLLECTOR when IKASH_TREASURY_ADDRESS is not set', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'SEND_CRYPTO_FEE_PERCENT') return '0.3';
        if (key === 'IKASH_TREASURY_ADDRESS') return null;
        return null;
      });
      usersRepository.findByPublicKey.mockResolvedValue(null);

      await expect(
        service.prepare(VALID_STELLAR_ADDRESS_1, VALID_STELLAR_ADDRESS_2, '1'),
      ).rejects.toThrow(AppException);

      try {
        await service.prepare(
          VALID_STELLAR_ADDRESS_1,
          VALID_STELLAR_ADDRESS_2,
          '1',
        );
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppException);
        expect(err.getResponse().error).toBe(ErrorCode.MISSING_FEE_COLLECTOR);
      }
    });

    it('calculates 0.3% fee and verifies total = amount + fee for amount 1', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.buildUnsignedUsdcSend.mockResolvedValue({
        xdr: 'AAAA_MOCK_XDR_1',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      const res = await service.prepare(
        VALID_STELLAR_ADDRESS_1,
        VALID_STELLAR_ADDRESS_2,
        '1',
      );

      expect(res.amount).toBe('1');
      expect(res.fee).toBe('0.003');
      expect(res.total).toBe('1.003');
      expect(res.asset).toBe('USDC');
      expect(res.unsignedXdr).toBe('AAAA_MOCK_XDR_1');
      expect(stellarService.buildUnsignedUsdcSend).toHaveBeenCalledWith({
        sourcePublicKey: VALID_STELLAR_ADDRESS_1,
        destination: VALID_STELLAR_ADDRESS_2,
        amount: '1',
        feeAddress: TREASURY_ADDRESS,
        feeAmount: '0.003',
      });
    });

    it('calculates 0.3% fee and verifies total = amount + fee for amount 0.1234567', async () => {
      usersRepository.findByPublicKey.mockResolvedValue(null);
      stellarService.buildUnsignedUsdcSend.mockResolvedValue({
        xdr: 'AAAA_MOCK_XDR_2',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      const res = await service.prepare(
        VALID_STELLAR_ADDRESS_1,
        VALID_STELLAR_ADDRESS_2,
        '0.1234567',
      );

      expect(res.amount).toBe('0.1234567');
      expect(res.fee).toBe('0.0003703');
      expect(res.total).toBe('0.123827');
      expect(res.unsignedXdr).toBe('AAAA_MOCK_XDR_2');
    });

    it('calculates 0.3% fee and verifies total = amount + fee for amount 1000', async () => {
      usersRepository.findByAlias.mockResolvedValue({
        publicKey: VALID_STELLAR_ADDRESS_2,
        alias: 'carol',
      });
      stellarService.buildUnsignedUsdcSend.mockResolvedValue({
        xdr: 'AAAA_MOCK_XDR_3',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      const res = await service.prepare(
        VALID_STELLAR_ADDRESS_1,
        'carol',
        '1000',
      );

      expect(res.recipient).toEqual({
        address: VALID_STELLAR_ADDRESS_2,
        alias: 'carol',
      });
      expect(res.amount).toBe('1000');
      expect(res.fee).toBe('3');
      expect(res.total).toBe('1003');
      expect(res.unsignedXdr).toBe('AAAA_MOCK_XDR_3');
    });
  });

  describe('submit', () => {
    it('delegates signed XDR submission to StellarService', async () => {
      stellarService.submitSignedXdr.mockResolvedValue({
        hash: 'tx-hash-123',
        ledger: 12345,
        successful: true,
      });

      const res = await service.submit('SIGNED_XDR_DATA');

      expect(res).toEqual({
        hash: 'tx-hash-123',
        ledger: 12345,
        successful: true,
      });
      expect(stellarService.submitSignedXdr).toHaveBeenCalledWith(
        'SIGNED_XDR_DATA',
      );
    });
  });
});
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { UsersRepository } from '../users/users.repository';
import { SendService } from './send.service';
import { AppException, ErrorCode } from '../../common/errors';

describe('SendService - stroop conversion helpers (#103)', () => {
  let service: SendService;

  beforeEach(() => {
    const mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'SEND_CRYPTO_FEE_PERCENT') return '0.3';
        if (key === 'IKASH_TREASURY_ADDRESS') return 'GBEXAMPLE';
        return null;
      }),
    } as unknown as ConfigService;

    const mockStellar = {} as unknown as StellarService;
    const mockUsers = {} as unknown as UsersRepository;

    service = new SendService(mockConfig, mockStellar, mockUsers);
  });

  describe('toStroops and fromStroops conversions', () => {
    // Typed test accessor for private helpers
    const toStroops = (amount: string): bigint =>
      (service as any).toStroops(amount);

    const fromStroops = (stroops: bigint): string =>
      (service as any).fromStroops(stroops);

    it('converts whole units correctly ("1" -> 10,000,000 stroops)', () => {
      expect(toStroops('1')).toBe(10_000_000n);
      expect(fromStroops(10_000_000n)).toBe('1');
    });

    it('round-trips standard and fractional amounts accurately', () => {
      const testCases = ['1', '0.0000001', '0.1234567', '1000'];
      for (const amount of testCases) {
        const stroops = toStroops(amount);
        const reconstructed = fromStroops(stroops);
        expect(reconstructed).toBe(amount);
      }
    });

    it('trims trailing zeros correctly so that "1.5000000" renders as "1.5"', () => {
      const stroops = toStroops('1.5000000');
      expect(stroops).toBe(15_000_000n);
      expect(fromStroops(stroops)).toBe('1.5');
    });

    it('handles exact zero decimal part cleanly', () => {
      expect(fromStroops(0n)).toBe('0');
      expect(fromStroops(100_000_000n)).toBe('10');
    });

    it('rejects invalid, negative, or malformed amounts with AppException(INVALID_AMOUNT)', () => {
      const invalidAmounts = ['0', '-1', '1.12345678', 'abc', '', '..', '1.'];

      for (const invalid of invalidAmounts) {
        expect(() => toStroops(invalid)).toThrow(
          expect.objectContaining({
            code: ErrorCode.INVALID_AMOUNT,
          }),
        );
      }
    });
  });
});
