import type { Express } from 'express';
import type { Pool } from 'pg';
import { createInventoryApp, type ErrorLogger } from './adapters/http/app.js';
import { PgCatalogRepository } from './adapters/postgres/pg-catalog-repository.js';
import { PgUnitOfWork } from './adapters/postgres/pg-unit-of-work.js';
import { CatalogService } from './application/catalog-service.js';
import { StockService } from './application/stock-service.js';
import { errorDetail, logJson } from './logging.js';

/**
 * The production composition root: HTTP adapter -> stock/catalog use cases -> the PostgreSQL ports of
 * the service's own database. The tests use this same function, so what they exercise is what the
 * container runs.
 */
export function createInventoryApplication(pool: Pool, logError?: ErrorLogger): Express {
  return createInventoryApp({
    catalog: new CatalogService(new PgCatalogRepository(pool)),
    stock: new StockService(new PgUnitOfWork(pool)),
    logError: logError ?? ((message, error) => logJson('error', message, errorDetail(error))),
  });
}
