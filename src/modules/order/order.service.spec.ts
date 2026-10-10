jest.mock('@stellar/stellar-sdk', () => ({}));

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { EscrowService } from '../escrow/escrow.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ORDER_PARTY_CONTACT_SELECT } from '../../common/prisma-selects';

describe('OrderService.cancel', () => {
  let service: OrderService;
  let repo: {
    findById: jest.Mock;
    update: jest.Mock;
  };

  const baseOrder = {
    orderId: 'order-1',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    orderStatus: 'created',
    escrow: null as { escrowStatus: string } | null,
  };

  beforeEach(async () => {
    repo = {
      findById: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: OrderRepository, useValue: repo },
        { provide: EscrowService, useValue: {} },
        { provide: AuditLogService, useValue: { create: jest.fn() } },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    service = module.get(OrderService);
  });

  it('cancels an order with no escrow yet', async () => {
    repo.findById.mockResolvedValue({ ...baseOrder });
    repo.update.mockResolvedValue({ ...baseOrder, orderStatus: 'cancelled' });

    await expect(service.cancel('order-1', 'buyer-1')).resolves.toEqual(
      expect.objectContaining({ orderStatus: 'cancelled' }),
    );
    expect(repo.update).toHaveBeenCalledWith('order-1', {
      orderStatus: 'cancelled',
    });
  });

  it('cancels an order whose escrow is only pending', async () => {
    repo.findById.mockResolvedValue({
      ...baseOrder,
      escrow: { escrowStatus: 'pending' },
    });
    repo.update.mockResolvedValue({ ...baseOrder, orderStatus: 'cancelled' });

    await expect(service.cancel('order-1', 'seller-1')).resolves.toBeDefined();
    expect(repo.update).toHaveBeenCalled();
  });

  it('cancels an order whose escrow is initialized but not funded', async () => {
    repo.findById.mockResolvedValue({
      ...baseOrder,
      escrow: { escrowStatus: 'initialized' },
    });
    repo.update.mockResolvedValue({ ...baseOrder, orderStatus: 'cancelled' });

    await expect(service.cancel('order-1', 'buyer-1')).resolves.toBeDefined();
    expect(repo.update).toHaveBeenCalled();
  });

  it('rejects cancellation from an unrelated user', async () => {
    repo.findById.mockResolvedValue({ ...baseOrder });

    await expect(service.cancel('order-1', 'stranger-1')).rejects.toThrow();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects cancellation when the order does not exist', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.cancel('missing-order', 'buyer-1')).rejects.toThrow();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it.each(['released', 'cancelled', 'expired', 'disputed'])(
    'rejects cancellation when the order is already "%s"',
    async (orderStatus) => {
      repo.findById.mockResolvedValue({ ...baseOrder, orderStatus });

      await expect(service.cancel('order-1', 'buyer-1')).rejects.toThrow();
      expect(repo.update).not.toHaveBeenCalled();
    },
  );

  it.each(['funded', 'fiat_sent', 'released', 'disputed', 'resolved'])(
    'rejects cancellation when the escrow is already "%s"',
    async (escrowStatus) => {
      repo.findById.mockResolvedValue({
        ...baseOrder,
        escrow: { escrowStatus },
      });

      await expect(service.cancel('order-1', 'buyer-1')).rejects.toThrow();
      expect(repo.update).not.toHaveBeenCalled();
    },
  );
});

describe('OrderService.expireOrders', () => {
  let service: OrderService;
  let prisma: { order: { findMany: jest.Mock; update: jest.Mock } };
  let escrowService: { getOnChainEscrowBalance: jest.Mock };
  let errorLog: jest.SpyInstance;
  const now = new Date('2026-10-08T12:00:00.000Z');

  const expiredOrder = (
    orderId: string,
    orderStatus: 'created' | 'locked',
    escrowStatus?: string,
  ) => ({
    orderId,
    orderStatus,
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    expiresAt: new Date('2026-10-08T11:59:00.000Z'),
    buyer: { alias: 'buyer', publicKey: 'buyer-public-key' },
    seller: { alias: 'seller', publicKey: 'seller-public-key' },
    escrow: escrowStatus
      ? { escrowStatus, contractId: `contract-${orderId}` }
      : null,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    prisma = {
      order: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    escrowService = {
      getOnChainEscrowBalance: jest.fn().mockResolvedValue([]),
    };
    const module = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: OrderRepository, useValue: {} },
        { provide: EscrowService, useValue: escrowService },
        { provide: AuditLogService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(OrderService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('selects only past-due active orders and handles an empty batch', async () => {
    prisma.order.findMany.mockResolvedValue([]);

    await expect(service.expireOrders()).resolves.toBeUndefined();

    expect(prisma.order.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lt: now },
        orderStatus: { in: ['created', 'locked'] },
      },
      include: {
        escrow: true,
        buyer: { select: ORDER_PARTY_CONTACT_SELECT },
        seller: { select: ORDER_PARTY_CONTACT_SELECT },
      },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(escrowService.getOnChainEscrowBalance).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  describe.each(['created', 'locked'] as const)('%s orders', (orderStatus) => {
    it.each(['fiat_sent', 'released', 'disputed', 'resolved'])(
      'leaves an order with %s escrow untouched while processing an eligible neighbor',
      async (escrowStatus) => {
        prisma.order.findMany.mockResolvedValue([
          expiredOrder('protected', orderStatus, escrowStatus),
          expiredOrder('eligible', orderStatus),
        ]);

        await service.expireOrders();

        expect(prisma.order.update).toHaveBeenCalledTimes(1);
        expect(prisma.order.update).toHaveBeenCalledWith({
          where: { orderId: 'eligible' },
          data: {
            orderStatus: orderStatus === 'locked' ? 'cancelled' : 'expired',
          },
        });
        expect(escrowService.getOnChainEscrowBalance).not.toHaveBeenCalled();
        expect(errorLog).not.toHaveBeenCalled();
      },
    );
  });

  it.each(['initialized', 'pending', 'funded'])(
    'expires created orders and cancels locked orders with %s escrow',
    async (escrowStatus) => {
      prisma.order.findMany.mockResolvedValue([
        expiredOrder('created-order', 'created', escrowStatus),
        expiredOrder('locked-order', 'locked', escrowStatus),
      ]);

      await service.expireOrders();

      expect(prisma.order.update).toHaveBeenCalledTimes(2);
      expect(prisma.order.update).toHaveBeenNthCalledWith(1, {
        where: { orderId: 'created-order' },
        data: { orderStatus: 'expired' },
      });
      expect(prisma.order.update).toHaveBeenNthCalledWith(2, {
        where: { orderId: 'locked-order' },
        data: { orderStatus: 'cancelled' },
      });
      expect(escrowService.getOnChainEscrowBalance).toHaveBeenCalledTimes(2);
      expect(escrowService.getOnChainEscrowBalance).toHaveBeenNthCalledWith(
        1,
        'contract-created-order',
      );
      expect(escrowService.getOnChainEscrowBalance).toHaveBeenNthCalledWith(
        2,
        'contract-locked-order',
      );
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it('continues processing the batch after an order update fails', async () => {
    const failure = new Error('Order update failed');
    prisma.order.findMany.mockResolvedValue([
      expiredOrder('failed-order', 'created'),
      expiredOrder('later-order', 'locked'),
    ]);
    prisma.order.update.mockRejectedValueOnce(failure);

    await expect(service.expireOrders()).resolves.toBeUndefined();

    expect(prisma.order.update).toHaveBeenCalledTimes(2);
    expect(prisma.order.update).toHaveBeenNthCalledWith(1, {
      where: { orderId: 'failed-order' },
      data: { orderStatus: 'expired' },
    });
    expect(prisma.order.update).toHaveBeenNthCalledWith(2, {
      where: { orderId: 'later-order' },
      data: { orderStatus: 'cancelled' },
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith('order.expiration.error', {
      orderId: 'failed-order',
      error: failure.message,
      stack: failure.stack,
    });
  });
});
