/** The slice of the `pg` API this service's adapter uses: a pool or a transaction-bound client. */

import type { QueryResult, QueryResultRow } from 'pg';

export interface Queryable {
  query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}
