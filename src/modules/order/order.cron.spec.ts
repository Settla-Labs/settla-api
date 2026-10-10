jest.mock('@stellar/stellar-sdk', () => ({}));

import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OrderCron } from './order.cron';
import { OrderService } from './order.service';

describe('OrderCron.expireOrders', () => {
  let cron: OrderCron;
  let orderService: { expireOrders: jest.Mock };
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    orderService = { expireOrders: jest.fn().mockResolvedValue(undefined) };
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const module = await Test.createTestingModule({
      providers: [OrderCron, { provide: OrderService, useValue: orderService }],
    }).compile();
    cron = module.get(OrderCron);
  });

  afterEach(() => jest.restoreAllMocks());

  it('delegates to the expiration service without logging an error on success', async () => {
    await expect(cron.expireOrders()).resolves.toBeUndefined();

    expect(orderService.expireOrders).toHaveBeenCalledTimes(1);
    expect(orderService.expireOrders).toHaveBeenCalledWith();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('swallows an expiration failure and logs its message and stack', async () => {
    const failure = new Error('Expiration query failed');
    orderService.expireOrders.mockRejectedValueOnce(failure);

    await expect(cron.expireOrders()).resolves.toBeUndefined();

    expect(orderService.expireOrders).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith('order.cron.expiration.failed', {
      error: failure.message,
      stack: failure.stack,
    });
  });
});
