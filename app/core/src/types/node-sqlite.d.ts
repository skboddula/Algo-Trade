/**
 * Minimal ambient types for node:sqlite (available since Node 22.5; stable
 * surface used by the daemon store). The installed @types/node predates
 * these declarations — runtime is verified, this only fills the type gap.
 */
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
  export class StatementSync {
    run(...params: unknown[]): void
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}
