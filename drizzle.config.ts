import { defineConfig } from 'drizzle-kit';

// drizzle-kit is a DEV-ONLY tool: it turns src/schema.ts into plain SQL
// migrations under src/migrations/ (applied by our own transactional runner,
// never by drizzle-kit migrate). File names are renamed NNN_* after
// generation to match the runner's user_version contract — see BUILD-STATE.md.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './src/migrations',
});
