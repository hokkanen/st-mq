# Original Elering market API evidence

Checked 2026-09-07 with bounded public GET requests. No API keys, account calls,
database changes or equipment commands were involved.

- The [Elering OpenAPI document](https://dashboard.elering.ee/v3/api-docs)
  identifies `/api/nps/price` as Nord Pool day-ahead price data and supports
  Estonia, Finland, Latvia and Lithuania. ST-MQ calls that original TSO endpoint
  directly. The response is `{success:true,data:{fi:[{timestamp,price}],...}}`;
  timestamps are UTC Unix seconds. Its price DTO still omits field semantics,
  and the separate current-price operation still says “current hour.” ST-MQ
  therefore does not use that outdated description to infer interval duration.
- [Nord Pool's transition notice](https://www.nordpoolgroup.com/en/trading/Operational-Message-List/2025/09/market-data---reminder-for-sdac-15-minute-go-live-20250905084800/)
  specifies 15-minute delivery from 2025-10-01, beginning at the Central European
  delivery-day boundary. Its [implementation confirmation](https://www.nordpoolgroup.com/en/message-center-container/newsroom/exchange-message-list/2025/q4/15-minute-mtu-in-sdac-was-implemented/)
  confirms the change took place.
- A six-hour request across that boundary returned Finnish hourly starts at
  `2025-09-30T20:00Z` and `21:00Z`, followed by `22:00Z`, `22:15Z`, `22:30Z`,
  `22:45Z`, etc. Accordingly, the original endpoint's terminal interval is one
  hour before `2025-09-30T22:00Z`, fifteen minutes from that instant. This is
  one hour after Finnish local midnight. Missing rows do not stretch neighboring
  prices to fill the gap.
- The [Elering homepage](https://elering.ee/) distinguishes EUR/MWh from
  cents/kWh and displays separate prices with its VAT toggle. For the first
  Estonian local hour on 2026-09-07 it displayed **26.19 EUR/MWh** before VAT and
  **32.48 EUR/MWh** with VAT. The original API's four quarter-hour values
  `27.69, 26.99, 25.73, 24.36` average to `26.1925`, independently matching the
  displayed price before VAT. The adapter therefore normalizes raw EUR/MWh to
  cents/kWh by multiplying by 0.1; household VAT and other charges are applied
  separately through the dated contract.

The implemented adapter's live GET returned **100 Finnish intervals**, from
`2026-09-06T21:00Z` through `2026-09-07T22:00Z`, with no gaps and complete
coverage of the ongoing Finnish day. Only the first local hour of tomorrow
was published at that check. The adapter preserved that actual end instead
of extending a final price to the requested end date.

Offline tests use authored synthetic rows, including negative values, the
hourly transition, missing periods, short/long daylight-saving days, primary
failures, source backoff and cancellation. The separate opt-in live suite
checks current provider availability and configured credentials; it must not
be confused with deterministic offline regression coverage.
