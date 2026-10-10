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
