import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'expo',
  schema: './app/services/db/schema.tsx',
  out: './app/services/db/drizzle',
});