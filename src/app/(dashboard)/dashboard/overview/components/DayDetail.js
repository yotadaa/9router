"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { fmt, fmtCost2, fmtTokens, fullDate } from "@/shared/utils/format";

const TOP_N = 5;

/** Right-aligned req/token figures shared by provider + model rows. */
function RowNumbers({ requests, tokens }) {
  return (
    <span className="shrink-0 text-right text-xs text-text-muted">
      {fmt(requests)} req · {fmtTokens(tokens)} tokens
    </span>
  );
}

RowNumbers.propTypes = {
  requests: PropTypes.number,
  tokens: PropTypes.number,
};

/** Top-5 entries of a byProvider/byModel map, ranked by requests desc. */
function topByRequests(map) {
  return Object.entries(map || {})
    .sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0))
    .slice(0, TOP_N);
}

/**
 * Drill-down panel for a single date picked from the activity calendar.
 * day = one /api/usage/daily row: { dateKey, requests, tokens, cost, byProvider, byModel }.
 */
export default function DayDetail({ day, onClose }) {
  const providerRows = topByRequests(day.byProvider);
  const modelRows = topByRequests(day.byModel);
  const hasBreakdown = providerRows.length > 0 || modelRows.length > 0;

  return (
    <Card title={<span className="font-bold">{fullDate(day.dateKey)}</span>}>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close day detail"
        className="text-text-muted hover:text-text-main hover:bg-black/5 rounded-full p-1 transition-colors"
      >
        <span className="material-symbols-outlined text-[20px]">close</span>
      </button>

      <div className="flex flex-wrap gap-4">
        <div>
          <div className="text-text-muted text-[10px] uppercase font-semibold">Tokens</div>
          <div className="text-text-main font-semibold">{fmtTokens(day.tokens || 0)}</div>
        </div>
        <div>
          <div className="text-text-muted text-[10px] uppercase font-semibold">Requests</div>
          <div className="text-text-main font-semibold">{fmt(day.requests || 0)}</div>
        </div>
        <div>
          <div className="text-text-muted text-[10px] uppercase font-semibold">Cost</div>
          <div className="text-text-main font-semibold">{fmtCost2(day.cost || 0)}</div>
        </div>
      </div>

      {!hasBreakdown ? (
        <p className="text-xs text-text-muted mt-4">No breakdown data for this day.</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <h4 className="text-text-muted text-xs uppercase font-semibold mb-2">Top Providers</h4>
            {providerRows.length === 0 ? (
              <p className="text-xs text-text-muted">No breakdown data for this day.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {providerRows.map(([id, v]) => (
                  <li key={id} className="flex min-w-0 items-center gap-2">
                    <ProviderIcon
                      src={`/providers/${id}.png`}
                      alt={id}
                      size={20}
                      fallbackText={id.slice(0, 2).toUpperCase()}
                    />
                    <span className="truncate text-sm">{id}</span>
                    <RowNumbers
                      requests={v.requests}
                      tokens={(v.promptTokens || 0) + (v.completionTokens || 0)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0">
            <h4 className="text-text-muted text-xs uppercase font-semibold mb-2">Top Models</h4>
            {modelRows.length === 0 ? (
              <p className="text-xs text-text-muted">No breakdown data for this day.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {modelRows.map(([key, v]) => (
                  <li key={key} className="flex min-w-0 items-center gap-2">
                    <span className="bg-bg text-text-muted inline-flex shrink-0 items-center justify-center rounded-lg">
                      <span className="material-symbols-outlined text-[14px]">smart_toy</span>
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{v.rawModel || key.split("|")[0]}</span>
                      <span className="text-text-muted truncate text-xs">{v.provider}</span>
                    </span>
                    <RowNumbers
                      requests={v.requests}
                      tokens={(v.promptTokens || 0) + (v.completionTokens || 0)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

DayDetail.propTypes = {
  day: PropTypes.shape({
    dateKey: PropTypes.string.isRequired,
    requests: PropTypes.number,
    tokens: PropTypes.number,
    cost: PropTypes.number,
    byProvider: PropTypes.object,
    byModel: PropTypes.object,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
};
