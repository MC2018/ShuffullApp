import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'expo',
  schema: './app/db/schema.tsx',
  out: './app/db/drizzle',
});