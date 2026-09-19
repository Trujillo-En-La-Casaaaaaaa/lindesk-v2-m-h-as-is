import type { QueryResult, QueryResultRow } from 'pg';

/**
 * The slice of `pg` the repositories need. Both `Pool` (reads outside a transaction) and `PoolClient`
 * (inside one) satisfy it, so the same repository implementation runs in both places.
 */
export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}
