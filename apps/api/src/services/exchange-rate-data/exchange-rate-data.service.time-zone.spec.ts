/**
 * @jest-environment <rootDir>/jest-environment-tz.js
 * @jest-environment-options {"timeZone": "America/New_York"}
 */
import { ExchangeRateDataService } from './exchange-rate-data.service';

describe('ExchangeRateDataService in a time zone behind UTC', () => {
  let dataProviderService: {
    getDataSourceForExchangeRates: jest.Mock;
    getHistorical: jest.Mock;
    getQuotes: jest.Mock;
  };
  let service: ExchangeRateDataService;

  beforeAll(() => {
    // 2024-01-10 21:30 in New York, but already 2024-01-11 in UTC
    jest.useFakeTimers().setSystemTime(new Date('2024-01-11T02:30:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    dataProviderService = {
      getDataSourceForExchangeRates: jest.fn().mockReturnValue('YAHOO'),
      getHistorical: jest.fn().mockResolvedValue({}),
      getQuotes: jest.fn().mockResolvedValue({})
    };

    service = new ExchangeRateDataService(
      dataProviderService as any,
      { get: jest.fn(), getRange: jest.fn() } as any,
      {
        account: { findMany: jest.fn().mockResolvedValue([]) },
        symbolProfile: { findMany: jest.fn().mockResolvedValue([]) }
      } as any,
      { getByKey: jest.fn().mockResolvedValue([]) } as any
    );
  });

  it('loads the rates of yesterday in UTC, not local time (regression #7723)', async () => {
    await service.loadCurrencies();

    const [, granularity, from, to] =
      dataProviderService.getHistorical.mock.calls[0];

    // Yesterday is 2024-01-10 in UTC (2024-01-09 in New York local time).
    expect(granularity).toBe('day');
    expect(from.toISOString()).toBe('2024-01-10T00:00:00.000Z');
    expect(to.toISOString()).toBe('2024-01-10T00:00:00.000Z');
  });
});
