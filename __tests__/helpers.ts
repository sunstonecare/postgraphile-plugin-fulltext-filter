/* eslint-disable no-param-reassign */
const { readFile } = require('fs')
const pg = require('pg')
const pgConnectionString = require('pg-connection-string')
const { createPostGraphileSchema } = require('postgraphile-core')

// This test suite can be flaky. Increase it’s timeout.
jest.setTimeout(1000 * 20)

function readFilePromise(filename, encoding) {
  return new Promise((resolve, reject) => {
    readFile(filename, encoding, (err, res) => {
      if (err) reject(err)
      else resolve(res)
    })
  })
}

export const withPgClient = async (url: any, fn?: any) => {
  if (!fn) {
    fn = url
    url = process.env.TEST_DATABASE_URL
  }
  const pgPool = new pg.Pool(pgConnectionString.parse(url))
  let client
  try {
    client = await pgPool.connect()
    await client.query('begin')
    await client.query("set local timezone to '+04:00'")
    const result = await fn(client)
    await client.query('rollback')
    return result
  } finally {
    try {
      await client.release()
    } catch (e) {
      console.error('Error releasing pgClient', e)
    }
    await pgPool.end()
  }
}

const withDbFromUrl = async (url, fn) =>
  withPgClient(url, async (client) => {
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE;')
      return fn(client)
    } finally {
      await client.query('COMMIT;')
    }
  })

export const withRootDb = (fn) => withDbFromUrl(process.env.TEST_DATABASE_URL, fn)

let prepopulatedDBKeepalive

const populateDatabase = async (client) => {
  await client.query(await readFilePromise(`${__dirname}/data.sql`, 'utf8'))
  return {}
}

export const withPrepopulatedDb = async (fn) => {
  if (!prepopulatedDBKeepalive) {
    throw new Error('You must call setup and teardown to use this')
  }
  const { client, vars } = prepopulatedDBKeepalive
  if (!vars) {
    throw new Error('No prepopulated vars')
  }
  let err
  try {
    await fn(client, vars)
  } catch (e) {
    err = e
  }
  try {
    await client.query('ROLLBACK TO SAVEPOINT pristine;')
  } catch (e) {
    err = err || e
    console.error('ERROR ROLLING BACK', e.message) // eslint-disable-line no-console
  }
  if (err) {
    throw err
  }
}

withPrepopulatedDb.setup = (done) => {
  if (prepopulatedDBKeepalive) {
    throw new Error("There's already a prepopulated DB running")
  }
  let res
  let rej
  prepopulatedDBKeepalive = new Promise((resolve, reject) => {
    res = resolve
    rej = reject
  })
  prepopulatedDBKeepalive.resolve = res
  prepopulatedDBKeepalive.reject = rej
  withRootDb(async (client) => {
    prepopulatedDBKeepalive.client = client
    try {
      prepopulatedDBKeepalive.vars = await populateDatabase(client)
    } catch (e) {
      console.error('FAILED TO PREPOPULATE DB!', e.message) // eslint-disable-line no-console
      return done(e)
    }
    await client.query('SAVEPOINT pristine;')
    done()
    return prepopulatedDBKeepalive
  })
}

withPrepopulatedDb.teardown = () => {
  if (!prepopulatedDBKeepalive) {
    throw new Error('Cannot tear down null!')
  }
  prepopulatedDBKeepalive.resolve() // Release DB transaction
  prepopulatedDBKeepalive = null
}

export const withSchema =
  ({ setup, test, options = {} }) =>
  () =>
    withPgClient(async (client) => {
      if (setup) {
        if (typeof setup === 'function') {
          await setup(client)
        } else {
          await client.query(setup)
        }
      }

      const schemaOptions = {
        appendPlugins: [require('postgraphile-plugin-connection-filter'), require('../src').default],
        showErrorStack: true,
        ...options,
      }

      const schema = await createPostGraphileSchema(client, ['fulltext_test'], schemaOptions)
      return test({
        schema,
        pgClient: client,
      })
    })

export const loadQuery = (fn) => readFilePromise(`${__dirname}/fixtures/queries/${fn}`, 'utf8')
