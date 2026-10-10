/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
jest.mock('@stellar/stellar-sdk', () => ({}));
jest.mock('../escrow/trustless-work.service', () => ({
  TrustlessWorkService: jest.fn(),
}));
jest.mock('axios');
import axios from 'axios';

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StellarListenerService } from './stellar-listener.service';
import { StellarEventParserService } from './stellar-event-parser.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { OnChainEscrowEvent } from './types/stellar-event.types';
import { AuditAction, AuditResult } from '../audit-log/enums/audit-action.enum';
import { EscrowService } from '../escrow/escrow.service';
import { OrderService } from '../order/order.service';

interface MockEscrowRecord {
  escrowId: string;
  orderId: string;
  contractId: string;
  escrowStatus: string;
  order: {
    orderId: string;
    buyerId: string;
    sellerId: string;
    orderStatus: string;
  };
}

describe('StellarListenerService', () => {
  let service: StellarListenerService;
  let findFirstEscrowMock: jest.Mock;
  let updateEscrowMock: jest.Mock;
  let updateOrderMock: jest.Mock;
  let createAuditMock: jest.Mock;

  const mockEscrow: MockEscrowRecord = {
    escrowId: 'escrow-123',
    orderId: 'order-123',
    contractId: 'CONTRACT_ABC',
    escrowStatus: 'initialized',
    order: {
      orderId: 'order-123',
      buyerId: 'buyer-user-1',
      sellerId: 'seller-user-2',
      orderStatus: 'created',
    },
  };

  beforeEach(async () => {
    findFirstEscrowMock = jest.fn().mockResolvedValue(mockEscrow);
    updateEscrowMock = jest
      .fn()
      .mockResolvedValue({ ...mockEscrow, escrowStatus: 'funded' });
    updateOrderMock = jest
      .fn()
      .mockResolvedValue({ orderId: 'order-123', orderStatus: 'locked' });
    createAuditMock = jest.fn().mockResolvedValue({ id: 'audit-log-1' });

    const prismaMock = {
      escrowOnChain: {
        findFirst: findFirstEscrowMock,
        findMany: jest.fn().mockResolvedValue([]),
        update: updateEscrowMock,
      },
      order: {
        update: updateOrderMock,
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: createAuditMock,
      },
      $transaction: jest
        .fn()
        .mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
          cb(prismaMock),
        ),
    };

    const auditLogMock = {
      create: createAuditMock,
    };

    const escrowServiceMock = {
      validateStatusTransition: jest.fn(),
      isTerminalOrAlreadyProcessed: jest.fn(
        (status: string, eventType: string) => {
          if (eventType === 'ESCROW_CREATED' && status !== 'pending')
            return true;
          if (
            eventType === 'ESCROW_FUNDED' &&
            ['funded', 'released', 'resolved'].includes(status)
          )
            return true;
          if (
            eventType === 'ESCROW_RELEASED' &&
            ['released', 'resolved'].includes(status)
          )
            return true;
          if (eventType === 'ESCROW_REFUNDED' && ['resolved'].includes(status))
            return true;
          if (
            eventType === 'ESCROW_CANCELLED' &&
            ['resolved', 'released'].includes(status)
          )
            return true;
          return false;
        },
      ),
      updateStatusFromOnChain: jest.fn(),
    };

    const orderServiceMock = {
      updateStatusFromOnChain: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarListenerService,
        StellarEventParserService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal?: string) => {
              if (key === 'STELLAR_RPC_URL')
                return 'https://soroban-testnet.stellar.org';
              if (key === 'TRUSTLESS_WORK_CONTRACT_ID') return 'CONTRACT_ABC';
              return defaultVal;
            }),
          },
        },
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditLogMock },
        { provide: EscrowService, useValue: escrowServiceMock },
        { provide: OrderService, useValue: orderServiceMock },
      ],
    }).compile();

    service = module.get(StellarListenerService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should process ESCROW_FUNDED event and update database & audit logs', async () => {
    const event: OnChainEscrowEvent = {
      eventId: 'evt-100:0',
      eventType: 'ESCROW_FUNDED',
      contractId: 'CONTRACT_ABC',
      txHash: 'txhash_fund_123',
      ledgerSequence: 1000,
      eventIndex: 0,
      engagementId: 'order-123',
    };

    const processed = await service.processEvent(event);
    expect(processed).toBe(true);
    expect(updateEscrowMock).toHaveBeenCalledWith({
      where: { escrowId: 'escrow-123' },
      data: expect.objectContaining({
        escrowStatus: 'funded',
        txHashLock: 'txhash_fund_123',
      }),
    });

    expect(updateOrderMock).toHaveBeenCalledWith({
      where: { orderId: 'order-123' },
      data: { orderStatus: 'locked' },
    });

    expect(createAuditMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: AuditAction.ESCROW_FUNDED,
        resourceType: 'Escrow',
        resourceId: 'escrow-123',
        result: AuditResult.SUCCESS,
        metadata: expect.objectContaining({
          contractId: 'CONTRACT_ABC',
          txHash: 'txhash_fund_123',
        }),
      }),
    });
  });

  it('should be idempotent and ignore duplicate event on second processing', async () => {
    const event: OnChainEscrowEvent = {
      eventId: 'evt-100:0',
      eventType: 'ESCROW_FUNDED',
      contractId: 'CONTRACT_ABC',
      txHash: 'txhash_fund_123',
      ledgerSequence: 1000,
      eventIndex: 0,
    };

    const first = await service.processEvent(event);
    expect(first).toBe(true);
    const second = await service.processEvent(event);
    expect(second).toBe(false);
    expect(updateEscrowMock).toHaveBeenCalledTimes(1);
  });

  it('should handle ESCROW_RELEASED event', async () => {
    findFirstEscrowMock.mockResolvedValueOnce({
      ...mockEscrow,
      escrowStatus: 'funded',
    });

    const event: OnChainEscrowEvent = {
      eventId: 'evt-101:0',
      eventType: 'ESCROW_RELEASED',
      contractId: 'CONTRACT_ABC',
      txHash: 'txhash_release_456',
      ledgerSequence: 1005,
      eventIndex: 0,
    };

    const released = await service.processEvent(event);
    expect(released).toBe(true);
    expect(updateEscrowMock).toHaveBeenCalledWith({
      where: { escrowId: 'escrow-123' },
      data: expect.objectContaining({
        escrowStatus: 'released',
        txHashRelease: 'txhash_release_456',
      }),
    });

    expect(updateOrderMock).toHaveBeenCalledWith({
      where: { orderId: 'order-123' },
      data: { orderStatus: 'released' },
    });

    expect(createAuditMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: AuditAction.ESCROW_RELEASED,
        resourceId: 'escrow-123',
      }),
    });
  });

  it('should handle ESCROW_REFUNDED event', async () => {
    findFirstEscrowMock.mockResolvedValueOnce({
      ...mockEscrow,
      escrowStatus: 'funded',
    });

    const event: OnChainEscrowEvent = {
      eventId: 'evt-102:0',
      eventType: 'ESCROW_REFUNDED',
      contractId: 'CONTRACT_ABC',
      txHash: 'txhash_refund_789',
      ledgerSequence: 1010,
      eventIndex: 0,
    };

    const refunded = await service.processEvent(event);
    expect(refunded).toBe(true);
    expect(updateEscrowMock).toHaveBeenCalledWith({
      where: { escrowId: 'escrow-123' },
      data: expect.objectContaining({
        escrowStatus: 'resolved',
        txHashRelease: 'txhash_refund_789',
      }),
    });

    expect(updateOrderMock).toHaveBeenCalledWith({
      where: { orderId: 'order-123' },
      data: { orderStatus: 'cancelled' },
    });
  });

  it('should return false gracefully if escrow record is not found', async () => {
    findFirstEscrowMock.mockResolvedValueOnce(null);

    const event: OnChainEscrowEvent = {
      eventId: 'evt-999:0',
      eventType: 'ESCROW_FUNDED',
      contractId: 'UNKNOWN_CONTRACT',
      txHash: 'txhash_unknown',
      ledgerSequence: 2000,
      eventIndex: 0,
    };

    const missing = await service.processEvent(event);
    expect(missing).toBe(false);
    expect(updateEscrowMock).not.toHaveBeenCalled();
  });

  it('should skip replayed ESCROW_CREATED event if escrow is already initialized/funded', async () => {
    findFirstEscrowMock.mockResolvedValueOnce({
      ...mockEscrow,
      escrowStatus: 'initialized',
    });

    const event: OnChainEscrowEvent = {
      eventId: 'evt-replay-create:0',
      eventType: 'ESCROW_CREATED',
      contractId: 'CONTRACT_ABC',
      txHash: 'txhash_create_replay',
      ledgerSequence: 900,
      eventIndex: 0,
    };

    const skipped = await service.processEvent(event);
    expect(skipped).toBe(false);
    expect(updateEscrowMock).not.toHaveBeenCalled();
  });

  it('should skip replayed ESCROW_CANCELLED event if escrow is already resolved/released', async () => {
    findFirstEscrowMock.mockResolvedValueOnce({
      ...mockEscrow,
      escrowStatus: 'resolved',
    });

    const event: OnChainEscrowEvent = {
      eventId: 'evt-replay-cancel:0',
      eventType: 'ESCROW_CANCELLED',
      contractId: 'CONTRACT_ABC',
      txHash: 'txhash_cancel_replay',
      ledgerSequence: 950,
      eventIndex: 0,
    };

    const skipped = await service.processEvent(event);
    expect(skipped).toBe(false);
    expect(updateEscrowMock).not.toHaveBeenCalled();
  });

  describe('queryEventsFromRpc pagination (Issue #59)', () => {
    const mockedAxios = axios as jest.Mocked<typeof axios>;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should trigger follow-up request using response cursor when 100 events returned', async () => {
      const page1Events = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-p1-${i}`,
        type: 'contract',
      }));
      const page2Events = Array.from({ length: 25 }, (_, i) => ({
        id: `evt-p2-${i}`,
        type: 'contract',
      }));

      (mockedAxios.post as jest.Mock)
        .mockResolvedValueOnce({
          data: {
            result: {
              events: page1Events,
              latestLedger: 5000,
              cursor: 'cursor-100',
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            result: {
              events: page2Events,
              latestLedger: 5000,
              cursor: 'cursor-125',
            },
          },
        });

      const res = await (service as any).queryEventsFromRpc(['CONTRACT_ABC']);

      expect(mockedAxios.post).toHaveBeenCalledTimes(2);

      // First call has limit 100 without cursor
      expect(mockedAxios.post).toHaveBeenNthCalledWith(
        1,
        'https://soroban-testnet.stellar.org',
        expect.objectContaining({
          method: 'getEvents',
          params: expect.objectContaining({
            pagination: { limit: 100 },
          }),
        }),
        expect.any(Object),
      );

      // Second call has limit 100 with continuation cursor
      expect(mockedAxios.post).toHaveBeenNthCalledWith(
        2,
        'https://soroban-testnet.stellar.org',
        expect.objectContaining({
          method: 'getEvents',
          params: expect.objectContaining({
            pagination: { limit: 100, cursor: 'cursor-100' },
          }),
        }),
        expect.any(Object),
      );

      // Returned event list contains events from every page (100 + 25 = 125)
      expect(res.events).toHaveLength(125);
      expect(res.latestLedger).toBe(5000);
    });

    it('should stop paging when a page returns fewer than 100 events', async () => {
      const pageEvents = Array.from({ length: 42 }, (_, i) => ({
        id: `evt-${i}`,
        type: 'contract',
      }));

      (mockedAxios.post as jest.Mock).mockResolvedValueOnce({
        data: {
          result: {
            events: pageEvents,
            latestLedger: 6000,
            cursor: 'cursor-42',
          },
        },
      });

      const res = await (service as any).queryEventsFromRpc(['CONTRACT_ABC']);

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(res.events).toHaveLength(42);
      expect(res.latestLedger).toBe(6000);
    });

    it('should log when page limit is hit and when multiple pages are processed in a single cycle', async () => {
      const loggerSpy = jest.spyOn((service as any).logger, 'log');

      const page1Events = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-p1-${i}`,
      }));
      const page2Events = Array.from({ length: 10 }, (_, i) => ({
        id: `evt-p2-${i}`,
      }));

      (mockedAxios.post as jest.Mock)
        .mockResolvedValueOnce({
          data: {
            result: {
              events: page1Events,
              cursor: 'cursor-100',
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            result: {
              events: page2Events,
            },
          },
        });

      await (service as any).queryEventsFromRpc(['CONTRACT_ABC']);

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('hit page limit (100 events)'),
      );
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Backlog processed'),
      );
    });

    it('should return empty events array gracefully when RPC throws error', async () => {
      (mockedAxios.post as jest.Mock).mockRejectedValueOnce(
        new Error('Network connection timeout'),
      );

      const res = await (service as any).queryEventsFromRpc(['CONTRACT_ABC']);
      expect(res.events).toEqual([]);
    });
  });
});
