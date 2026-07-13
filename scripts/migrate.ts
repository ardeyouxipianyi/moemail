import { readFileSync, readdirSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'

const execAsync = promisify(exec)

interface D1Database {
  binding: string
  database_name: string
  database_id: string
}

interface WranglerConfig {
  d1_databases: D1Database[]
}

interface D1QueryResult {
  success?: boolean
  results?: Array<Record<string, unknown>>
}

interface CloudflareResponse {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result?: D1QueryResult[]
}

async function queryRemoteDatabase(
  accountId: string,
  databaseId: string,
  apiToken: string,
  sql: string
): Promise<D1QueryResult[]> {
  const url = 'https://api.cloudflare.com/client/v4/accounts/' + accountId +
    '/d1/database/' + databaseId + '/query'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  })
  const data = await response.json() as CloudflareResponse
  const failedStatement = data.result?.some((item) => item.success === false)

  if (!response.ok || !data.success || failedStatement) {
    const details = data.errors?.map((error) => error.code + ': ' + error.message).join('; ')
      || JSON.stringify(data.result)
    throw new Error('Cloudflare D1 API request failed (' + response.status + '): ' + details)
  }

  return data.result || []
}

async function migrateRemote(config: WranglerConfig) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const databaseId = config.d1_databases[0].database_id

  if (!accountId || !apiToken || !databaseId) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and database_id are required')
  }

  await queryRemoteDatabase(
    accountId,
    databaseId,
    apiToken,
    'CREATE TABLE IF NOT EXISTS "_moemail_migrations" (' +
      '"name" TEXT PRIMARY KEY NOT NULL, "applied_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);'
  )

  const appliedResult = await queryRemoteDatabase(
    accountId,
    databaseId,
    apiToken,
    'SELECT "name" FROM "_moemail_migrations";'
  )
  const applied = new Set(
    appliedResult.flatMap((item) => item.results || [])
      .map((row) => String(row.name))
  )

  const migrationsPath = join(process.cwd(), 'drizzle')
  const migrationFiles = readdirSync(migrationsPath)
    .filter((filename) => filename.endsWith('.sql'))
    .sort()

  for (const filename of migrationFiles) {
    if (applied.has(filename)) {
      console.log('Skipping already applied migration: ' + filename)
      continue
    }

    console.log('Applying migration: ' + filename)
    const content = readFileSync(join(migrationsPath, filename), 'utf-8').trim()
    const migrationSql = content.endsWith(';') ? content : content + ';'
    const escapedName = filename.replaceAll("'", "''")
    const trackedSql = migrationSql +
      '\nINSERT INTO "_moemail_migrations" ("name") VALUES (\'' + escapedName + '\');'

    await queryRemoteDatabase(accountId, databaseId, apiToken, trackedSql)
    console.log('Applied migration: ' + filename)
  }
}

async function migrate() {
  try {
    const args = process.argv.slice(2)
    const mode = args[0]

    if (!mode || !['local', 'remote'].includes(mode)) {
      console.error('Error: Please specify mode (local or remote)')
      process.exit(1)
    }

    const wranglerPath = join(process.cwd(), 'wrangler.json')
    let wranglerContent: string

    try {
      wranglerContent = readFileSync(wranglerPath, 'utf-8')
    } catch {
      console.error('Error: wrangler.json not found')
      process.exit(1)
    }

    const config = JSON.parse(wranglerContent) as WranglerConfig

    if (!config.d1_databases?.[0]?.database_name || !config.d1_databases[0].database_id) {
      console.error('Error: Database name or ID not found in wrangler.json')
      process.exit(1)
    }

    const dbName = config.d1_databases[0].database_name

    console.log('Generating migrations...')
    await execAsync('drizzle-kit generate')

    console.log('Applying migrations to ' + mode + ' database: ' + dbName)
    if (mode === 'remote') {
      await migrateRemote(config)
    } else {
      const dbBinding = config.d1_databases[0].binding
      await execAsync('wrangler d1 migrations apply ' + dbBinding + ' --local --config wrangler.json')
    }

    console.log('Migration completed successfully!')
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

migrate()
