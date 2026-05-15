#!/usr/bin/env node
/**
 * Axess GY — User seed helper.
 *
 * Reads `users.json` (template at users.example.json), generates a strong
 * random password for each user, hashes it with PBKDF2-SHA256 (100k iterations,
 * matching the Worker), and prints:
 *
 *   1. The plaintext passwords (so you can send them to each user once).
 *   2. The `wrangler kv key put` commands to load each user into KV.
 *
 * Usage:
 *   1. Copy users.example.json → users.json and fill in your users.
 *   2. Run:  node seed-users.js
 *   3. Paste the generated `wrangler` commands into your terminal.
 *   4. Distribute the plaintext passwords to each user via secure channel.
 *   5. DELETE users.json after you're done (passwords are NOT stored).
 *
 * Required: Node.js 18+, `wrangler` already authenticated (`npx wrangler login`).
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';

const pbkdf2 = promisify(crypto.pbkdf2);

const PBKDF2_ITERATIONS = 100000;
const PWD_LENGTH = 16;
const PWD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(len = PWD_LENGTH) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PWD_ALPHABET[bytes[i] % PWD_ALPHABET.length];
  return out;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  return salt.toString('hex') + '.' + hash.toString('hex');
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

async function main() {
  if (!existsSync('users.json')) {
    console.error('\nERROR: users.json not found.\n');
    console.error('Create it from the template:\n  cp users.example.json users.json\n');
    process.exit(1);
  }

  const users = JSON.parse(readFileSync('users.json', 'utf8'));
  if (!Array.isArray(users) || users.length === 0) {
    console.error('users.json must be a non-empty array');
    process.exit(1);
  }

  const credentials = [];
  const commands = [];

  for (const u of users) {
    if (!u.username) { console.error('skipping user without username:', u); continue; }
    const username = String(u.username).trim().toLowerCase();
    const password = u.password || generatePassword();
    const passwordHash = await hashPassword(password);
    const record = {
      passwordHash,
      name: u.name || username,
      email: u.email || '',
      role: u.role || 'viewer',
      createdAt: new Date().toISOString()
    };
    credentials.push({ username, password, name: record.name, email: record.email });
    const cmd = `npx wrangler kv key put --binding USERS ${shellQuote(username)} ${shellQuote(JSON.stringify(record))}`;
    commands.push(cmd);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STEP 1 · Save these credentials (each user gets their password)');
  console.log('══════════════════════════════════════════════════════════════════\n');
  console.log('username           password         name                      email');
  console.log('─'.repeat(80));
  for (const c of credentials) {
    console.log(c.username.padEnd(18) + ' ' + c.password.padEnd(16) + ' ' + (c.name || '').padEnd(25) + ' ' + (c.email || ''));
  }
  console.log('\n  → Share each row with its user via secure channel (1Password, signed email, etc.)');
  console.log('  → DELETE users.json after running the commands below.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STEP 2 · Run these commands to upload users to KV');
  console.log('══════════════════════════════════════════════════════════════════\n');
  for (const cmd of commands) console.log(cmd);
  console.log('\n  (Make sure `wrangler login` is done first; commands target the USERS binding in wrangler.toml)\n');
}

main().catch(e => { console.error(e); process.exit(1); });
