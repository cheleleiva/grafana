// Libraries
import _ from 'lodash';
import moment from 'moment';
import { from, Observable, combineLatest } from 'rxjs';
import { webSocket } from 'rxjs/webSocket';
import { map, mergeMap } from 'rxjs/operators';

// Services & Utils
import * as dateMath from 'app/core/utils/datemath';
import { addLabelToSelector } from 'app/plugins/datasource/prometheus/add_label_to_query';
import LanguageProvider from './language_provider';
import { mergeStreamsToLogs } from './result_transformer';
import { formatQuery, parseQuery } from './query_utils';
import { makeSeriesForLogs } from 'app/core/logs_model';

// Types
import { LogsStream, LogsModel } from 'app/core/logs_model';
import { PluginMeta, DataQueryOptions, DataQueryResponse } from '@grafana/ui/src/types';
import { LokiQuery } from './types';
import { EXPLORE_POLLING_INTERVAL_MS } from 'app/core/utils/explore';

export const DEFAULT_MAX_LINES = 1000;

interface LokiStreamResult {
  labels: { [key: string]: string };
  entries: [
    {
      ts: string;
      line: string;
    }
  ];
}

const DEFAULT_QUERY_PARAMS = {
  direction: 'BACKWARD',
  limit: DEFAULT_MAX_LINES,
  regexp: '',
  query: '',
};

function serializeParams(data: any) {
  return Object.keys(data)
    .map(k => {
      const v = data[k];
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    })
    .join('&');
}

export class LokiDatasource {
  languageProvider: LanguageProvider;
  maxLines: number;

  supportsStreaming = true;

  /** @ngInject */
  constructor(private instanceSettings, private backendSrv, private templateSrv) {
    this.languageProvider = new LanguageProvider(this);
    const settingsData = instanceSettings.jsonData || {};
    this.maxLines = parseInt(settingsData.maxLines, 10) || DEFAULT_MAX_LINES;
  }

  _request(apiUrl: string, data?, options?: any) {
    const baseUrl = this.instanceSettings.url;
    const params = data ? serializeParams(data) : '';
    const url = `${baseUrl}${apiUrl}?${params}`;
    const req = {
      ...options,
      url,
    };
    return this.backendSrv.datasourceRequest(req);
  }

  _stream(apiUrl: string, data?: any, options?: any): Observable<LokiStreamResult> {
    return from(this.backendSrv.get(`api/datasources/${this.instanceSettings.id}`)).pipe(
      map((result: any) => {
        const baseUrl = new URL('', result.url);
        const params = data ? `${serializeParams(data)}` : '';
        const url = `ws://${result.basicAuthUser}:${result.basicAuthPassword}@${baseUrl.host}${apiUrl}?${params}`;
        return webSocket<LokiStreamResult>(url);
      }),
      mergeMap(stream => stream)
    );
  }

  mergeStreams(streams: LogsStream[], intervalMs: number): LogsModel {
    const logs = mergeStreamsToLogs(streams, this.maxLines);
    logs.series = makeSeriesForLogs(logs.rows, intervalMs);
    return logs;
  }

  prepareQueryTarget(target: LokiQuery, options: DataQueryOptions<LokiQuery>) {
    const streaming = options.streaming;
    const interpolated = this.templateSrv.replace(target.expr);
    const now = moment();
    const liveStreamStart = now.clone().subtract(EXPLORE_POLLING_INTERVAL_MS, 'milliseconds');
    const liveStreamEnd = now.clone();
    const start = streaming ? this.getTime(liveStreamStart, false) : this.getTime(options.range.from, false);
    const end = streaming ? this.getTime(liveStreamEnd, true) : this.getTime(options.range.to, true);
    return {
      ...DEFAULT_QUERY_PARAMS,
      ...parseQuery(interpolated),
      start,
      end,
      limit: this.maxLines,
    };
  }

  prepareStreamQueryTarget(target: LokiQuery, options: DataQueryOptions<LokiQuery>) {
    const interpolated = this.templateSrv.replace(target.expr);
    return {
      ...parseQuery(interpolated),
    };
  }

  stream(options: DataQueryOptions<LokiQuery>): Observable<DataQueryResponse> {
    const queryTargets = options.targets
      .filter(target => target.expr && !target.hide)
      .map(target => this.prepareStreamQueryTarget(target, options));

    if (queryTargets.length === 0) {
      return from([]);
    }

    const queryStreams$ = queryTargets.map(target => this._stream('/api/prom/tail', target));
    return combineLatest(...queryStreams$).pipe(
      mergeMap(result => result),
      map(result => {
        const allStreams: LogsStream[] = [result];
        return { data: allStreams };
      })
    );
  }

  async query(options: DataQueryOptions<LokiQuery>) {
    const queryTargets = options.targets
      .filter(target => target.expr && !target.hide)
      .map(target => this.prepareQueryTarget(target, options));

    if (queryTargets.length === 0) {
      return Promise.resolve({ data: [] });
    }

    const queries = queryTargets.map(target => this._request('/api/prom/query', target));

    return Promise.all(queries).then((results: any[]) => {
      const allStreams: LogsStream[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const query = queryTargets[i];

        // add search term to stream & add to array
        if (result.data) {
          for (const stream of result.data.streams || []) {
            stream.search = query.regexp;
            allStreams.push(stream);
          }
        }
      }

      // check resultType
      if (options.targets[0].format === 'time_series') {
        const logs = mergeStreamsToLogs(allStreams, this.maxLines);
        logs.series = makeSeriesForLogs(logs.rows, options.intervalMs);
        return { data: logs.series };
      } else {
        return { data: allStreams };
      }
    });
  }

  async importQueries(queries: LokiQuery[], originMeta: PluginMeta): Promise<LokiQuery[]> {
    return this.languageProvider.importQueries(queries, originMeta.id);
  }

  metadataRequest(url) {
    // HACK to get label values for {job=|}, will be replaced when implementing LokiQueryField
    const apiUrl = url.replace('v1', 'prom');
    return this._request(apiUrl, { silent: true }).then(res => {
      const data = { data: { data: res.data.values || [] } };
      return data;
    });
  }

  modifyQuery(query: LokiQuery, action: any): LokiQuery {
    const parsed = parseQuery(query.expr || '');
    let selector = parsed.query;
    switch (action.type) {
      case 'ADD_FILTER': {
        selector = addLabelToSelector(selector, action.key, action.value);
        break;
      }
      default:
        break;
    }
    const expression = formatQuery(selector, parsed.regexp);
    return { ...query, expr: expression };
  }

  getHighlighterExpression(query: LokiQuery): string {
    return parseQuery(query.expr).regexp;
  }

  getTime(date, roundUp) {
    if (_.isString(date)) {
      date = dateMath.parse(date, roundUp);
    }
    return Math.ceil(date.valueOf() * 1e6);
  }

  testDatasource() {
    return this._request('/api/prom/label')
      .then(res => {
        if (res && res.data && res.data.values && res.data.values.length > 0) {
          return { status: 'success', message: 'Data source connected and labels found.' };
        }
        return {
          status: 'error',
          message:
            'Data source connected, but no labels received. Verify that Loki and Promtail is configured properly.',
        };
      })
      .catch(err => {
        let message = 'Loki: ';
        if (err.statusText) {
          message += err.statusText;
        } else {
          message += 'Cannot connect to Loki';
        }

        if (err.status) {
          message += `. ${err.status}`;
        }

        if (err.data && err.data.message) {
          message += `. ${err.data.message}`;
        } else if (err.data) {
          message += `. ${err.data}`;
        }
        return { status: 'error', message: message };
      });
  }
}

export default LokiDatasource;
