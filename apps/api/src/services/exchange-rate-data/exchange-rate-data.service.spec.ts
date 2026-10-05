import { DATE_FORMAT, parseDate } from '@ghostfolio/common/helper';

import { Logger } from '@nestjs/common';
import { DataSource } from '@prisma/client';
import { format, subDays } from 'date-fns';

import { ExchangeRateDataService } from './exchange-rate-data.service';

describe('ExchangeRateDataService', () => {
  const DEFAULT_SYSTEM_TIME = '2024-01-10T12:00:00.000Z'; // a Wednesday

  // In-memory market data rows. The fake MarketDataService below respects the
  // dateQuery filter semantics ({ gte: startDate, lt: endDate }) so tests read
  // like fixtures rather than call-by-call mocks.
  let marketDataRows: {
    dataSource: DataSource;
    marketPrice: number;
    symbol: string;
    date: Date;
  }[];

  let historicalData: {
    [assetProfileIdentifier: string]: {
      [date: string]: { marketPrice: number };
    };
  };

  let quotes: {
    [assetProfileIdentifier: string]: { marketPrice: number };
  };

  let accountCurrencies: string[];
  let customCurrencies: string[];
  let symbolProfileCurrencies: string[];

  let dataProviderService: {
    getDataSourceForExchangeRates: jest.Mock;
    getHistorical: jest.Mock;
    getQuotes: jest.Mock;
  };
  let marketDataService: { get: jest.Mock; getRange: jest.Mock };
  let prismaService: {
    account: { findMany: jest.Mock };
    symbolProfile: { findMany: jest.Mock };
  };
  let propertyService: { getByKey: jest.Mock };
  let service: ExchangeRateDataService;

  let errorLogSpy: jest.SpyInstance;

  const datesFrom = ({ start, end }: { start: string; end: string }) => {
    const dates: string[] = [];
    let date = parseDate(start);
    const endDate = parseDate(end);

    while (date <= endDate) {
      dates.push(format(date, DATE_FORMAT));
      date = subDays(date, -1);
    }

    return dates;
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(DEFAULT_SYSTEM_TIME));

    marketDataRows = [];
    historicalData = {};
    quotes = {};
    accountCurrencies = [];
    customCurrencies = [];
    symbolProfileCurrencies = [];

    dataProviderService = {
      getDataSourceForExchangeRates: jest.fn().mockReturnValue('YAHOO'),
      getHistorical: jest.fn().mockImplementation(() => {
        return Promise.resolve(historicalData);
      }),
      getQuotes: jest.fn().mockImplementation(() => {
        return Promise.resolve(quotes);
      })
    };

    marketDataService = {
      get: jest.fn().mockImplementation(({ dataSource, date, symbol }) => {
        const dateString = format(date, DATE_FORMAT);

        return Promise.resolve(
          marketDataRows.find((row) => {
            return (
              row.dataSource === dataSource &&
              row.symbol === symbol &&
              format(row.date, DATE_FORMAT) === dateString
            );
          }) ?? null
        );
      }),
      getRange: jest
        .fn()
        .mockImplementation(({ assetProfileIdentifiers, dateQuery }) => {
          const [{ dataSource, symbol }] = assetProfileIdentifiers;

          return Promise.resolve(
            marketDataRows
              .filter((row) => {
                return (
                  row.dataSource === dataSource &&
                  row.symbol === symbol &&
                  (!dateQuery?.gte || row.date >= dateQuery.gte) &&
                  (!dateQuery?.lt || row.date < dateQuery.lt)
                );
              })
              .sort((a, b) => a.date.getTime() - b.date.getTime())
          );
        })
    };

    prismaService = {
      account: {
        findMany: jest.fn().mockImplementation(() => {
          return Promise.resolve(
            accountCurrencies.map((currency) => ({ currency }))
          );
        })
      },
      symbolProfile: {
        findMany: jest.fn().mockImplementation(() => {
          return Promise.resolve(
            symbolProfileCurrencies.map((currency) => ({ currency }))
          );
        })
      }
    };

    propertyService = {
      getByKey: jest.fn().mockImplementation(() => {
        return Promise.resolve(customCurrencies);
      })
    };

    service = new ExchangeRateDataService(
      dataProviderService as any,
      marketDataService as any,
      prismaService as any,
      propertyService as any
    );

    errorLogSpy = jest
      .spyOn(service['logger'] as Logger, 'error')
      .mockImplementation(() => {
        return undefined;
      });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('getExchangeRatesByCurrency', () => {
    it('returns an empty object when startDate is not provided', async () => {
      await expect(
        service.getExchangeRatesByCurrency({
          currencies: ['EUR'],
          startDate: undefined,
          targetCurrency: 'USD'
        })
      ).resolves.toEqual({});

      expect(marketDataService.getRange).not.toHaveBeenCalled();
    });

    it('returns an empty object when currencies is empty', async () => {
      await expect(
        service.getExchangeRatesByCurrency({
          currencies: [],
          startDate: parseDate('2024-01-01'),
          targetCurrency: 'USD'
        })
      ).resolves.toEqual({});
    });

    it('returns 1 for every day when currency and target currency are identical', async () => {
      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['USD'],
        startDate: parseDate('2024-01-01'),
        targetCurrency: 'USD'
      });

      expect(
        datesFrom({ start: '2024-01-01', end: '2024-01-10' })
      ).toHaveLength(10);

      expect(exchangeRates['USDUSD']).toEqual(
        Object.fromEntries(
          datesFrom({ start: '2024-01-01', end: '2024-01-10' }).map(
            (dateString) => [dateString, 1]
          )
        )
      );

      expect(marketDataService.getRange).not.toHaveBeenCalled();
    });

    it('returns the stored rates of a direct currency pair', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.08,
          symbol: 'EURUSD',
          date: parseDate('2024-01-08')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 1.09,
          symbol: 'EURUSD',
          date: parseDate('2024-01-09')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-08'),
        targetCurrency: 'USD'
      });

      expect(exchangeRates['EURUSD']['2024-01-08']).toBe(1.08);
      expect(exchangeRates['EURUSD']['2024-01-09']).toBe(1.09);

      expect(marketDataService.getRange).toHaveBeenCalledWith(
        expect.objectContaining({
          assetProfileIdentifiers: [{ dataSource: 'YAHOO', symbol: 'EURUSD' }]
        })
      );
    });

    it('returns a rate for every day of the range, including days without data', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.08,
          symbol: 'EURUSD',
          date: parseDate('2024-01-03')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-01'),
        targetCurrency: 'USD'
      });

      expect(Object.keys(exchangeRates['EURUSD']).sort()).toEqual(
        datesFrom({ start: '2024-01-01', end: '2024-01-10' })
      );
    });

    it('pins current behaviour: fills weekend gaps with the rate of the following weekday', async () => {
      // 2024-01-05 is a Friday, 2024-01-08 the following Monday. The fill loop
      // walks backwards from endDate and carries the last value it saw, so
      // Saturday and Sunday are filled with Monday's rate (look-ahead), not
      // Friday's.
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.1,
          symbol: 'EURUSD',
          date: parseDate('2024-01-05')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 1.2,
          symbol: 'EURUSD',
          date: parseDate('2024-01-08')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-05'),
        targetCurrency: 'USD'
      });

      expect(exchangeRates['EURUSD']['2024-01-05']).toBe(1.1);
      expect(exchangeRates['EURUSD']['2024-01-06']).toBe(1.2);
      expect(exchangeRates['EURUSD']['2024-01-07']).toBe(1.2);
      expect(exchangeRates['EURUSD']['2024-01-08']).toBe(1.2);
    });

    it('fills days after the last stored rate with the latest available rate', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.1,
          symbol: 'EURUSD',
          date: parseDate('2024-01-06')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-06'),
        targetCurrency: 'USD'
      });

      expect(exchangeRates['EURUSD']['2024-01-08']).toBe(1.1);
      expect(exchangeRates['EURUSD']['2024-01-10']).toBe(1.1);
    });

    it('fills days before the first stored rate with the earliest available rate', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.1,
          symbol: 'EURUSD',
          date: parseDate('2024-01-05')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-01'),
        targetCurrency: 'USD'
      });

      expect(exchangeRates['EURUSD']['2024-01-01']).toBe(1.1);
      expect(exchangeRates['EURUSD']['2024-01-04']).toBe(1.1);
    });

    it('pins current behaviour: falls back to a rate of 1 for every day when no rate exists, logging an error per day for USD', async () => {
      // No USDEUR data anywhere: direct lookup empty, indirect lookup empty.
      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['USD'],
        startDate: parseDate('2024-01-08'),
        targetCurrency: 'EUR'
      });

      expect(exchangeRates['USDEUR']).toEqual({
        '2024-01-08': 1,
        '2024-01-09': 1,
        '2024-01-10': 1
      });

      // The gap-fill error ('...at <date>' without a 'Please complement'
      // suffix) is logged only when the source currency is USD.
      const gapFillErrors = errorLogSpy.mock.calls.filter(([message]) => {
        return (
          /No exchange rate has been found for USDEUR at \d{4}/.test(message) &&
          !message.includes('Please complement')
        );
      });

      // One per missing day before today, logged in reverse order (the
      // fill loop walks backwards from endDate). The missing rate for today
      // itself is only logged by the via-USD path.
      expect(gapFillErrors.map(([message]) => message)).toEqual([
        'No exchange rate has been found for USDEUR at 2024-01-09',
        'No exchange rate has been found for USDEUR at 2024-01-08'
      ]);
    });

    it('pins current behaviour: a non-USD pair falls back to 1 without a gap-fill error (the via-USD path logs its own errors)', async () => {
      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'USD'
      });

      expect(exchangeRates['EURUSD']['2024-01-09']).toBe(1);
      expect(exchangeRates['EURUSD']['2024-01-10']).toBe(1);

      // getExchangeRates logs one error per missing day, but the gap-fill
      // loop does not (it only logs for USD).
      expect(
        errorLogSpy.mock.calls.every(([message]) => {
          return message.includes('Please complement market data');
        })
      ).toBe(true);
      expect(errorLogSpy).toHaveBeenCalledTimes(2);
    });

    it('pins current behaviour: re-queries the same pair via the base currency when the source currency is USD', async () => {
      // USDCHF has no data. The indirect path asks for USDCHF again as the
      // "to" leg — a redundant query that still yields no rate.
      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['USD'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'CHF'
      });

      expect(exchangeRates['USDCHF']['2024-01-09']).toBe(1);
      expect(exchangeRates['USDCHF']['2024-01-10']).toBe(1);

      expect(
        marketDataService.getRange.mock.calls.filter(
          ([{ assetProfileIdentifiers }]) => {
            return assetProfileIdentifiers[0].symbol === 'USDCHF';
          }
        )
      ).toHaveLength(2);
    });

    it('computes a missing pair inversely via the base currency (EURUSD from USDEUR)', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.8,
          symbol: 'USDEUR',
          date: parseDate('2024-01-09')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'USD'
      });

      // factor = (1 / USDEUR) * USDUSD = 1 / 0.8 * 1
      expect(exchangeRates['EURUSD']['2024-01-09']).toBeCloseTo(1.25);
      expect(exchangeRates['EURUSD']['2024-01-10']).toBeCloseTo(1.25);
    });

    it('computes a missing pair inversely when the target currency is the base currency', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.8,
          symbol: 'USDEUR',
          date: parseDate('2024-01-09')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 0.9,
          symbol: 'USDCHF',
          date: parseDate('2024-01-09')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'CHF'
      });

      // factor = USDCHF / USDEUR = 0.9 / 0.8
      expect(exchangeRates['EURCHF']['2024-01-09']).toBeCloseTo(1.125);
    });

    it('logs days where an indirect leg is missing and fills them from a neighbour', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.8,
          symbol: 'USDEUR',
          date: parseDate('2024-01-09')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 0.9,
          symbol: 'USDCHF',
          date: parseDate('2024-01-09')
        },
        // USDEUR has no row for 2024-01-10
        {
          dataSource: 'YAHOO',
          marketPrice: 0.85,
          symbol: 'USDCHF',
          date: parseDate('2024-01-10')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'CHF'
      });

      expect(errorLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Please complement market data for USDEUR and USDCHF.'
        )
      );

      // Walking backwards from endDate, the latest stored rate
      // (2024-01-09) seeds previousExchangeRate, so the day after it is
      // filled with the earlier rate.
      expect(exchangeRates['EURCHF']['2024-01-10']).toBeCloseTo(1.125);
      expect(exchangeRates['EURCHF']['2024-01-09']).toBeCloseTo(1.125);
    });

    it('swallows errors thrown while querying an indirect leg', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.9,
          symbol: 'USDCHF',
          date: parseDate('2024-01-09')
        }
      ];

      marketDataService.getRange.mockImplementation(
        ({ assetProfileIdentifiers }) => {
          const [{ symbol }] = assetProfileIdentifiers;

          if (symbol === 'USDEUR') {
            return Promise.reject(new Error('DB gone'));
          }

          return Promise.resolve(
            marketDataRows.filter((row) => row.symbol === symbol)
          );
        }
      );

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'CHF'
      });

      // EURCHF: all days missing → filled with 1
      expect(exchangeRates['EURCHF']['2024-01-09']).toBe(1);
    });

    it('rejects when the direct market data query fails', async () => {
      marketDataService.getRange.mockRejectedValue(new Error('DB gone'));

      await expect(
        service.getExchangeRatesByCurrency({
          currencies: ['EUR'],
          startDate: parseDate('2024-01-09'),
          targetCurrency: 'USD'
        })
      ).rejects.toThrow('DB gone');
    });

    it('resolves multiple currencies independently, including the target currency', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.1,
          symbol: 'EURUSD',
          date: parseDate('2024-01-09')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 0.9,
          symbol: 'CHFUSD',
          date: parseDate('2024-01-09')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR', 'USD', 'CHF', 'EUR'], // duplicates are harmless
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'USD'
      });

      expect(Object.keys(exchangeRates).sort()).toEqual([
        'CHFUSD',
        'EURUSD',
        'USDUSD'
      ]);
      expect(exchangeRates['USDUSD']['2024-01-09']).toBe(1);
      expect(exchangeRates['EURUSD']['2024-01-09']).toBe(1.1);
      expect(exchangeRates['CHFUSD']['2024-01-09']).toBe(0.9);
    });

    it('uses derived currency factors once initialized (GBp/GBP)', async () => {
      accountCurrencies = ['GBP'];
      await service.initialize();

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['GBp'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'GBP'
      });

      expect(exchangeRates['GBpGBP']['2024-01-09']).toBeCloseTo(0.01);

      expect(
        marketDataService.getRange.mock.calls.filter(
          ([{ assetProfileIdentifiers }]) => {
            return assetProfileIdentifiers[0].symbol === 'GBpGBP';
          }
        )
      ).toHaveLength(0);
    });

    it('uses the inverse derived currency factor (GBP/GBp)', async () => {
      accountCurrencies = ['GBP'];
      await service.initialize();

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['GBP'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'GBp'
      });

      expect(exchangeRates['GBPGBp']['2024-01-09']).toBeCloseTo(100);
    });

    it('pins current behaviour: derived currency factors are unknown before initialize() runs', async () => {
      // GBpGBP falls through to the database before initialize().
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.05,
          symbol: 'GBpGBP',
          date: parseDate('2024-01-09')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['GBp'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'GBP'
      });

      expect(exchangeRates['GBpGBP']['2024-01-09']).toBe(0.05);
      expect(marketDataService.getRange).toHaveBeenCalledWith(
        expect.objectContaining({
          assetProfileIdentifiers: [{ dataSource: 'YAHOO', symbol: 'GBpGBP' }]
        })
      );
    });

    it('pins current behaviour: queries market data up to today even for a historical endDate', async () => {
      const historicalEndDate = parseDate('2024-01-05');

      await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        endDate: historicalEndDate,
        startDate: parseDate('2024-01-01'),
        targetCurrency: 'USD'
      });

      // endDate is not passed down to getExchangeRates; the query runs with
      // the default lt: <today> bound.
      expect(marketDataService.getRange).toHaveBeenCalledWith(
        expect.objectContaining({
          dateQuery: {
            gte: parseDate('2024-01-01'),
            lt: expect.any(Date)
          }
        })
      );

      const [{ dateQuery }] = marketDataService.getRange.mock.calls.find(
        ([{ assetProfileIdentifiers }]) => {
          return assetProfileIdentifiers[0].symbol === 'EURUSD';
        }
      );
      expect(format(dateQuery.lt, DATE_FORMAT)).toBe('2024-01-10');
    });

    it('pins current behaviour: omits the start date key when startDate carries a time component', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.1,
          symbol: 'EURUSD',
          date: parseDate('2024-01-08')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 1.2,
          symbol: 'EURUSD',
          date: parseDate('2024-01-09')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: new Date('2024-01-08T15:00:00.000Z'),
        targetCurrency: 'USD'
      });

      // The loop compares resetHours(date) with startDate, so the start day
      // itself is not filled even though it is part of the query range.
      expect(exchangeRates['EURUSD']['2024-01-08']).toBeUndefined();
      expect(exchangeRates['EURUSD']['2024-01-09']).toBe(1.2);
    });

    it('pins current behaviour: a zero base-currency rate produces Infinity', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0,
          symbol: 'USDEUR',
          date: parseDate('2024-01-09')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 0.9,
          symbol: 'USDCHF',
          date: parseDate('2024-01-09')
        }
      ];

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['EUR'],
        startDate: parseDate('2024-01-09'),
        targetCurrency: 'CHF'
      });

      // (1 / 0) * 0.9 = Infinity passes the isNaN check and is stored.
      expect(exchangeRates['EURCHF']['2024-01-09']).toBe(Infinity);
    });
  });

  describe('toCurrency', () => {
    beforeEach(async () => {
      // Rates for yesterday (2024-01-09 UTC).
      historicalData = {
        'YAHOO-USDEUR': { '2024-01-09': { marketPrice: 0.8 } },
        'YAHOO-USDCHF': { '2024-01-09': { marketPrice: 0.9 } }
      };

      accountCurrencies = ['EUR', 'CHF'];
      await service.initialize();
    });

    it('returns 0 for a zero value', () => {
      expect(service.toCurrency(0, 'EUR', 'USD')).toBe(0);
    });

    it('returns the value unchanged when the currencies are identical', () => {
      expect(service.toCurrency(100, 'USD', 'USD')).toBe(100);
    });

    it('converts with a direct rate', () => {
      expect(service.toCurrency(10, 'USD', 'EUR')).toBeCloseTo(8);
    });

    it('converts with an inverse rate computed during loadCurrencies', () => {
      expect(service.toCurrency(8, 'EUR', 'USD')).toBeCloseTo(10);
    });

    it('converts indirectly via the base currency', () => {
      // EURCHF = USDEUR⁻¹ * USDCHF = 0.9 / 0.8
      expect(service.toCurrency(10, 'EUR', 'CHF')).toBeCloseTo(11.25);
    });

    it('pins current behaviour: does not cache the indirectly computed rate', () => {
      service.toCurrency(10, 'EUR', 'CHF');

      // Guard against regression #7618: the cross rate must not be memoized.
      expect(service['exchangeRates']['EURCHF']).toBeUndefined();
    });

    it('pins current behaviour: returns the value unconverted when no rate exists', () => {
      expect(service.toCurrency(100, 'EUR', 'GBP')).toBe(100);
      expect(errorLogSpy).toHaveBeenCalledWith(
        'No exchange rate has been found for EURGBP'
      );
    });
  });

  describe('toCurrencyAtDate', () => {
    it('returns 0 for a zero value', async () => {
      await expect(
        service.toCurrencyAtDate(0, 'EUR', 'USD', parseDate('2024-01-05'))
      ).resolves.toBe(0);
    });

    it('delegates to toCurrency for today', async () => {
      accountCurrencies = ['EUR'];
      await service.initialize();

      const toCurrencySpy = jest.spyOn(service, 'toCurrency');

      await service.toCurrencyAtDate(10, 'EUR', 'USD', new Date());

      expect(toCurrencySpy).toHaveBeenCalledWith(10, 'EUR', 'USD');
      expect(marketDataService.get).not.toHaveBeenCalled();
    });

    it('returns 1 times the value when the currencies are identical', async () => {
      await expect(
        service.toCurrencyAtDate(10, 'USD', 'USD', parseDate('2024-01-05'))
      ).resolves.toBe(10);
    });

    it('uses the derived currency factor when available', async () => {
      accountCurrencies = ['GBP'];
      await service.initialize();

      await expect(
        service.toCurrencyAtDate(100, 'GBp', 'GBP', parseDate('2024-01-05'))
      ).resolves.toBeCloseTo(1);

      expect(marketDataService.get).not.toHaveBeenCalled();
    });

    it('uses the stored rate of the requested date', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 1.1,
          symbol: 'EURUSD',
          date: parseDate('2024-01-05')
        }
      ];

      await expect(
        service.toCurrencyAtDate(10, 'EUR', 'USD', parseDate('2024-01-05'))
      ).resolves.toBe(11);

      expect(marketDataService.get).toHaveBeenCalledWith({
        dataSource: 'YAHOO',
        symbol: 'EURUSD',
        date: parseDate('2024-01-05')
      });
    });

    it('pins current behaviour: treats a stored rate of 0 as missing and falls back to the indirect calculation', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0,
          symbol: 'EURUSD',
          date: parseDate('2024-01-05')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 0.5,
          symbol: 'USDEUR',
          date: parseDate('2024-01-05')
        }
      ];

      // (1 / 0.5) * 1 = 2, even though EURUSD is stored as 0.
      await expect(
        service.toCurrencyAtDate(10, 'EUR', 'USD', parseDate('2024-01-05'))
      ).resolves.toBe(20);
    });

    it('computes the factor via the base currency when no direct rate is stored (from = USD)', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.9,
          symbol: 'USDCHF',
          date: parseDate('2024-01-05')
        }
      ];

      await expect(
        service.toCurrencyAtDate(10, 'USD', 'CHF', parseDate('2024-01-05'))
      ).resolves.toBe(9);
    });

    it('computes the factor via the base currency when no direct rate is stored (to = USD)', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.8,
          symbol: 'USDEUR',
          date: parseDate('2024-01-05')
        }
      ];

      await expect(
        service.toCurrencyAtDate(10, 'EUR', 'USD', parseDate('2024-01-05'))
      ).resolves.toBeCloseTo(12.5);
    });

    it('computes a cross rate via the base currency', async () => {
      marketDataRows = [
        {
          dataSource: 'YAHOO',
          marketPrice: 0.8,
          symbol: 'USDEUR',
          date: parseDate('2024-01-05')
        },
        {
          dataSource: 'YAHOO',
          marketPrice: 0.9,
          symbol: 'USDCHF',
          date: parseDate('2024-01-05')
        }
      ];

      await expect(
        service.toCurrencyAtDate(10, 'EUR', 'CHF', parseDate('2024-01-05'))
      ).resolves.toBeCloseTo(11.25);
    });

    it('pins current behaviour: returns undefined when no rate can be computed', async () => {
      await expect(
        service.toCurrencyAtDate(10, 'EUR', 'GBP', parseDate('2024-01-05'))
      ).resolves.toBeUndefined();

      expect(errorLogSpy).toHaveBeenCalledWith(
        'No exchange rate has been found for EURGBP at 2024-01-05'
      );
    });

    it('pins current behaviour: rejects when the direct market data lookup fails', async () => {
      marketDataService.get.mockRejectedValue(new Error('DB gone'));

      await expect(
        service.toCurrencyAtDate(10, 'EUR', 'USD', parseDate('2024-01-05'))
      ).rejects.toThrow('DB gone');
    });

    it('pins current behaviour: swallows errors of the indirect lookups and returns undefined', async () => {
      marketDataService.get.mockImplementation(({ symbol }) => {
        if (symbol === 'EURCHF') {
          return Promise.resolve(null);
        }

        return Promise.reject(new Error('DB gone'));
      });

      await expect(
        service.toCurrencyAtDate(10, 'EUR', 'CHF', parseDate('2024-01-05'))
      ).resolves.toBeUndefined();
    });
  });

  describe('initialize and loadCurrencies', () => {
    it('merges currencies from accounts, symbol profiles and the custom property', async () => {
      accountCurrencies = ['EUR'];
      symbolProfileCurrencies = ['CHF'];
      customCurrencies = ['XYZ'];

      await service.initialize();

      // Sorted, deduplicated, with USX always appended and GBp pulled in via
      // no root currency here.
      expect(service.getCurrencies()).toEqual([
        'CHF',
        'EUR',
        'USD',
        'USX',
        'XYZ'
      ]);
    });

    it('adds a derived currency when its root currency is present (and vice versa)', async () => {
      accountCurrencies = ['GBP'];

      await service.initialize();

      expect(service.getCurrencies()).toContain('GBp');
      expect(service.getCurrencies()).toContain('GBP');
    });

    it('builds USD currency pairs for every non-USD currency', async () => {
      accountCurrencies = ['EUR', 'GBP'];

      await service.initialize();

      // Order follows the deduplicated currency list: EUR, GBP, then GBp
      // (appended as the derived currency of GBP), then USX.
      expect(service.getCurrencyPairs().map(({ symbol }) => symbol)).toEqual([
        'USDEUR',
        'USDGBP',
        'USDGBp',
        'USDUSX'
      ]);
    });

    it('loads the rate of yesterday and computes the inverse pair', async () => {
      historicalData = {
        'YAHOO-USDEUR': { '2024-01-09': { marketPrice: 0.8 } }
      };
      accountCurrencies = ['EUR'];

      await service.initialize();

      expect(service['exchangeRates']['USDEUR']).toBe(0.8);
      expect(service['exchangeRates']['EURUSD']).toBeCloseTo(1.25);
    });

    it('prefers a live quote over historical data for yesterday', async () => {
      historicalData = {
        'YAHOO-USDEUR': { '2024-01-09': { marketPrice: 0.8 } }
      };
      quotes = {
        'YAHOO-USDEUR': { marketPrice: 0.85 }
      };
      accountCurrencies = ['EUR'];

      await service.initialize();

      expect(service['exchangeRates']['USDEUR']).toBe(0.85);
    });

    it('computes inverse rates for all loaded pairs', async () => {
      historicalData = {
        'YAHOO-USDEUR': { '2024-01-09': { marketPrice: 0.8 } },
        'YAHOO-USDCHF': { '2024-01-09': { marketPrice: 0.9 } }
      };
      accountCurrencies = ['EUR', 'CHF'];

      await service.initialize();

      expect(service['exchangeRates']['USDEUR']).toBe(0.8);
      expect(service['exchangeRates']['EURUSD']).toBeCloseTo(1.25);
      expect(service['exchangeRates']['USDCHF']).toBe(0.9);
      expect(service['exchangeRates']['CHFUSD']).toBeCloseTo(1 / 0.9);
    });

    it('pins current behaviour: a gathered pair with no data stores no entry', async () => {
      // USDXYZ is gathered but has no data, so it never enters the result
      // map at all: no rate and no inverse are stored.
      accountCurrencies = ['XYZ'];

      await service.initialize();

      expect(service['exchangeRates']['USDXYZ']).toBeUndefined();
      expect(service['exchangeRates']['XYZUSD']).toBeUndefined();

      // toCurrency then returns the value unconverted and logs an error.
      expect(service.toCurrency(10, 'USD', 'XYZ')).toBe(10);
      expect(errorLogSpy).toHaveBeenCalledWith(
        'No exchange rate has been found for USDXYZ'
      );
    });

    it('pins current behaviour: a gathered pair whose only data is older than yesterday stores NaN', async () => {
      // USDEUR has data, but not for yesterday. The indirect fallback
      // computes USDUSD * USDEUR = NaN and stores it.
      historicalData = {
        'YAHOO-USDEUR': { '2024-01-08': { marketPrice: 0.8 } }
      };
      accountCurrencies = ['EUR'];

      await service.initialize();

      expect(Number.isNaN(service['exchangeRates']['USDEUR'])).toBe(true);
      expect(Number.isNaN(service['exchangeRates']['EURUSD'])).toBe(true);
    });

    it('pins current behaviour: a stored rate of 0 produces an inverse of Infinity', async () => {
      historicalData = {
        'YAHOO-USDEUR': { '2024-01-09': { marketPrice: 0 } }
      };
      accountCurrencies = ['EUR'];

      await service.initialize();

      expect(service['exchangeRates']['EURUSD']).toBe(Infinity);
    });

    it('resets its state when initialized again', async () => {
      accountCurrencies = ['EUR'];
      await service.initialize();

      const firstPairs = service.getCurrencyPairs().length;

      accountCurrencies = ['EUR', 'CHF'];
      await service.initialize();

      expect(service.getCurrencyPairs().length).toBeGreaterThan(firstPairs);
      expect(service.getCurrencies()).toContain('CHF');
    });
  });

  describe('getCurrencies, getCurrencyPairs and hasCurrencyPair', () => {
    it('returns [USD] before initialize() runs', () => {
      expect(service.getCurrencies()).toEqual(['USD']);
      expect(service.getCurrencyPairs()).toEqual([]);
    });

    it('checks currency pairs in both directions', async () => {
      accountCurrencies = ['EUR'];
      await service.initialize();

      expect(service.hasCurrencyPair('USD', 'EUR')).toBe(true);
      expect(service.hasCurrencyPair('EUR', 'USD')).toBe(true);
      expect(service.hasCurrencyPair('EUR', 'CHF')).toBe(false);
    });
  });
});
