const assert = require('node:assert/strict');
const { beforeEach, afterEach, describe, it } = require('node:test');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migrationsDirectory = join(__dirname, '../prisma/migrations');
const migrationName =
  '20261008210000_enforce_global_payment_provider_uniqueness';
const migration = readFileSync(
  join(migrationsDirectory, migrationName, 'migration.sql'),
  'utf8',
);
const id = (value) =>
  `00000000-0000-0000-0000-${value.toString().padStart(12, '0')}`;

describe('global payment provider uniqueness migration', () => {
  let db;

  beforeEach(async () => {
    db = new PGlite();
    // Exercise the actual schema/migration history, including its foreign keys.
    for (const directory of readdirSync(migrationsDirectory, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && entry.name < migrationName)
      .map((entry) => entry.name)
      .sort()) {
      await db.exec(
        readFileSync(
          join(migrationsDirectory, directory, 'migration.sql'),
          'utf8',
        ),
      );
    }
  });

  afterEach(async () => {
    await db.close();
  });

  const insertProvider = async (
    value,
    name = 'Dummy Bank',
    type = 'BANK',
    country = null,
    createdAt = '2026-01-01T00:00:00Z',
  ) => {
    await db.query(
      `INSERT INTO payment_provider
       (provider_id, name, type, country_code, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id(value), name, type, country, createdAt],
    );
  };

  it('reproduces the old NULL-country hole and rejects it after migration', async () => {
    await insertProvider(1);
    await insertProvider(2);
    assert.equal(
      (await db.query('SELECT provider_id FROM payment_provider')).rows.length,
      2,
    );

    await db.exec(migration);

    assert.deepEqual(
      (await db.query('SELECT provider_id FROM payment_provider')).rows,
      [{ provider_id: id(1) }],
    );
    await assert.rejects(insertProvider(3), { code: '23505' });
  });

  it('preserves methods and offer links while deterministically merging each duplicate group', async () => {
    // Insertion order and UUID order do not override the oldest creation time.
    await insertProvider(1, 'Dummy Bank', 'BANK', null, '2026-02-01T00:00:00Z');
    await insertProvider(3);
    await insertProvider(2);
    await insertProvider(5, 'Dummy Bank', 'PLATFORM');
    await insertProvider(4, 'Dummy Bank', 'PLATFORM');
    await insertProvider(6, 'Other Bank');
    await insertProvider(7, 'Dummy Bank', 'BANK', 'SE');
    await insertProvider(8, 'Dummy Bank', 'BANK', 'PL');
    await db.query(
      `UPDATE payment_provider SET is_active = false,
       metadata = '{"fixture":"keep original settings"}' WHERE provider_id = $1`,
      [id(2)],
    );
    const providersBefore = (
      await db.query('SELECT * FROM payment_provider ORDER BY provider_id')
    ).rows;
    await db.query(
      'INSERT INTO app_user (user_id, public_key) VALUES ($1, $2)',
      [id(100), 'dummy-migration-user'],
    );
    await db.query(
      `INSERT INTO offer
       (offer_id, creator_id, type, asset_code, price, min_amount, max_amount)
       VALUES ($1, $2, 'buy', 'DUMMY', 1, 1, 2)`,
      [id(200), id(100)],
    );
    for (const provider of providersBefore) {
      const paymentId = provider.provider_id.replace('00000000-', '10000000-');
      await db.query(
        `INSERT INTO payment_method
         (payment_id, user_id, provider_id, type, account_identifier, description)
         SELECT $1, $2, provider_id, type, $3, 'keep this method'
         FROM payment_provider WHERE provider_id = $4`,
        [paymentId, id(100), `dummy-${paymentId}`, provider.provider_id],
      );
      await db.query('INSERT INTO "_OfferPaymentMethods" VALUES ($1, $2)', [
        id(200),
        paymentId,
      ]);
    }
    const methodsBefore = (
      await db.query('SELECT * FROM payment_method ORDER BY payment_id')
    ).rows;
    const linksBefore = (
      await db.query('SELECT * FROM "_OfferPaymentMethods" ORDER BY "B"')
    ).rows;

    await db.exec(migration);

    const replacements = new Map([
      [id(1), id(2)],
      [id(3), id(2)],
      [id(5), id(4)],
    ]);
    assert.deepEqual(
      (await db.query('SELECT * FROM payment_method ORDER BY payment_id')).rows,
      methodsBefore.map((method) => ({
        ...method,
        provider_id: replacements.get(method.provider_id) ?? method.provider_id,
      })),
    );
    assert.deepEqual(
      (await db.query('SELECT * FROM "_OfferPaymentMethods" ORDER BY "B"'))
        .rows,
      linksBefore,
    );
    assert.deepEqual(
      (await db.query('SELECT * FROM payment_provider ORDER BY provider_id'))
        .rows,
      providersBefore.filter(
        (provider) => !replacements.has(provider.provider_id),
      ),
    );
  });

  it('allows distinct global names/types and country-specific providers', async () => {
    await db.exec(migration);
    await insertProvider(1);
    await insertProvider(2, 'Other Bank');
    await insertProvider(3, 'Dummy Bank', 'PLATFORM');
    await insertProvider(4, 'Dummy Bank', 'BANK', 'SE');
    await insertProvider(5, 'Dummy Bank', 'BANK', 'PL');
    assert.equal(
      (await db.query('SELECT provider_id FROM payment_provider')).rows.length,
      5,
    );
    // Both the new global rule and the original country-specific rule hold.
    await assert.rejects(insertProvider(6), { code: '23505' });
    await assert.rejects(insertProvider(7, 'Dummy Bank', 'BANK', 'SE'), {
      code: '23505',
    });
  });
});
