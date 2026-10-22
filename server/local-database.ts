import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import type { Client, Transaction, InStatement, InArgs, ResultSet, Row } from '@libsql/client'

export type QueryTransaction = Pick<Transaction, 'execute' | 'batch' | 'commit' | 'close'>
export type DatabaseClient = Pick<Client, 'execute' | 'executeMultiple' | 'close'> & {
  transaction(mode: 'read' | 'write'): Promise<QueryTransaction>
}

// Keep Node's existing SQLite driver for local files; Turso uses the HTTP client.
export function localDatabase(path: string): DatabaseClient {
  const db = new DatabaseSync(path)
  const execute: Client['execute'] = async (input: InStatement | string, args?: InArgs): Promise<ResultSet> => {
    const sql = typeof input === 'string' ? input : input.sql
    const values = (typeof input === 'string' ? args : input.args) ?? []
    const statement = db.prepare(sql)
    const columns = statement.columns()
    let rows: Row[] = []
    let rowsAffected = 0
    let lastInsertRowid: bigint | undefined
    if (columns.length) rows = (Array.isArray(values) ? statement.all(...values as SQLInputValue[]) : statement.all(values as Record<string, SQLInputValue>)) as unknown as Row[]
    else {
      const result = Array.isArray(values) ? statement.run(...values as SQLInputValue[]) : statement.run(values as Record<string, SQLInputValue>)
      rowsAffected = Number(result.changes); lastInsertRowid = BigInt(result.lastInsertRowid)
    }
    return { columns: columns.map(column => column.name), columnTypes: columns.map(column => column.type ?? ''), rows, rowsAffected, lastInsertRowid,
      toJSON: () => ({ rows, rowsAffected, lastInsertRowid: lastInsertRowid?.toString() }) }
  }
  return {
    execute,
    executeMultiple: async sql => { db.exec(sql) },
    close: () => db.close(),
    transaction: async mode => {
      db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
      let closed = false
      return {
        execute,
        batch: async statements => {
          const results: ResultSet[] = []
          for (const input of statements) results.push(await (Array.isArray(input) ? execute(input[0], input[1]) : execute(input)))
          return results
        },
        commit: async () => { db.exec('COMMIT'); closed = true },
        close: () => { if (!closed) { db.exec('ROLLBACK'); closed = true } },
      }
    },
  }
}
