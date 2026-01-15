import pg from "pg";

const { Client } = pg;

type LockResult = {
  acquired: boolean;
};

export async function withAdvisoryLock(
  label: string,
  fn: () => Promise<void>
): Promise<LockResult> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn(`[Worker] DATABASE_URL missing; skipping advisory lock for ${label}`);
    return { acquired: false };
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked",
      [label]
    );
    const locked = rows[0]?.locked === true;
    if (!locked) {
      return { acquired: false };
    }

    try {
      await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [
        label,
      ]);
    }

    return { acquired: true };
  } catch (error) {
    console.warn(`[Worker] Advisory lock error for ${label}:`, error);
    return { acquired: false };
  } finally {
    try {
      await client.end();
    } catch (error) {
      console.warn(`[Worker] Failed to close lock connection for ${label}:`, error);
    }
  }
}
